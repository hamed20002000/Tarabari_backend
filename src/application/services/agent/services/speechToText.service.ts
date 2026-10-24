import { Injectable, Logger } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { basename, isAbsolute, join } from 'node:path';
import { cpus } from 'node:os';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { SerialTaskQueue } from '../common/serialTaskQueue';
import { Transcript, transcribeSpeech } from '../common/llmClient';

const execFileAsync = promisify(execFile);

const LOCAL_FILES = join(process.cwd(), 'src/application/services/agent/localFiles');

// برش فرکانس‌های خیلی پایین/بالا (لرزش میکروفون، نویز) و یکسان کردن بلندی صدا؛
// ویس‌های پیام‌رسان معمولاً یا خیلی آرومن یا clip شدن.
const AUDIO_FILTER = 'highpass=f=80,lowpass=f=7600,loudnorm';

export interface WhisperOptions {
  /** اسم فایل داخل models/ یا مسیر کامل */
  model: string;
  /** واژه‌های حوزه‌ی کار که whisper باید انتظارشون رو داشته باشه؛ خالی یعنی بدون prompt */
  prompt: string;
  /** حذف سکوت‌ها با Silero قبل از whisper */
  vad: boolean;
}

interface TranscriptCorrection {
  from: RegExp;
  to: string;
}

/**
 * whisper روی سکوت، موسیقی و صدای نامفهوم متن ساختگی می‌سازه («زیرنویس …»،
 * «از از از از»، یا خود prompt) -- چنین خروجی‌ای یعنی چیزی تشخیص داده نشد و
 * نباید به مدل تشخیص بار بره.
 */
export function cleanTranscript(raw: string, prompt = ''): string {
  const text = raw
    .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ') // [BLANK_AUDIO]، (موسیقی)
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  if (/زیرنویس|amara|subtitle/i.test(text)) return '';
  // گفتار فارسی که نه حرف فارسی داره نه عدد، حدس مدل روی صدای نامفهومه.
  if (!/[؀-ۿ\p{N}]/u.test(text)) return '';
  if (text.length >= 15 && prompt.includes(text.replace(/[.،,]+$/, ''))) return '';

  const words = text.split(' ');
  if (words.length >= 3 && new Set(words).size === 1) return '';
  return text;
}

function loadCorrections(): TranscriptCorrection[] {
  try {
    const rules = JSON.parse(readFileSync(join(LOCAL_FILES, 'stt_corrections.json'), 'utf8')) as {
      from: string;
      to: string;
    }[];
    return rules.map((rule) => ({ from: new RegExp(rule.from, 'gu'), to: rule.to }));
  } catch {
    return [];
  }
}

/**
 * تبدیل پیام صوتی به متن -- مشترک بین گروه/کانال‌های بار همه‌ی پلتفرم‌ها. اول OpenAI
 * (OPENAI_STT_MODEL)، اگه جواب نداد whisper.cpp محلی (یا با LLM_LOCAL_FALLBACK=off، خطا).
 *
 * whisper سنگینه، برای همین اجراهای محلی پشت‌سرهم (نه هم‌زمان) انجام می‌شن.
 * اگه whisper.cpp با CUDA ساخته شده باشه، خودش از GPU استفاده می‌کنه.
 */
@Injectable()
export class SpeechToTextService {
  private readonly logger = new Logger(SpeechToTextService.name);

  private readonly whisperDir = process.env.WHISPER_CPP_DIR || '/home/hamed/whisper.cpp';
  // build-cuda: ساخت با GPU (اگه هست)؛ وگرنه ساخت CPU.
  private readonly whisperBinary =
    process.env.WHISPER_CLI ||
    [join(this.whisperDir, 'build-cuda', 'bin', 'whisper-cli'), join(this.whisperDir, 'build', 'bin', 'whisper-cli')].find(
      (path) => existsSync(path),
    ) ||
    join(this.whisperDir, 'build', 'bin', 'whisper-cli');
  private readonly language = process.env.WHISPER_LANGUAGE || 'fa';
  // نصف هسته‌ها -- بقیه برای خود برنامه و Ollama آزاد می‌مونه.
  private readonly threads = Math.max(4, Math.floor(cpus().length / 2));
  // داخل پروژه، نه /tmp: ffmpeg نصب‌شده با snap یک /tmp خصوصی داره و فایل‌های
  // /tmp برنامه رو نمی‌بینه.
  private readonly workDir = process.env.VOICE_WORK_DIR || join(process.cwd(), 'uploads', 'voice-tmp');

  private readonly defaults: WhisperOptions = {
    model: process.env.WHISPER_MODEL_PATH || 'ggml-large-v3-q5_0.bin',
    prompt: this.defaultPrompt(),
    vad: process.env.WHISPER_VAD !== 'off',
  };
  private readonly vadModel = this.existingPath(process.env.WHISPER_VAD_MODEL || 'ggml-silero-v6.2.0.bin');
  private readonly corrections = loadCorrections();
  // اختیاری: هر ویس (بعد از فیلتر) و متنش اینجا می‌مونه تا نمونه‌ی ارزیابی/آموزش بشه.
  private readonly sampleDir = process.env.STT_SAMPLE_DIR || null;

  /** پیام‌های صوتی طولانی‌تر از این (ثانیه) پردازش نمی‌شن تا صف قفل نشه. */
  static readonly MAX_DURATION_SECONDS = Number(process.env.VOICE_MAX_DURATION_SECONDS) || 180;
  private static readonly TIMEOUT_MS = 5 * 60 * 1000;

  private readonly queue = new SerialTaskQueue();

  get vadAvailable(): boolean {
    return this.vadModel !== null;
  }

  /**
   * فایل صوتی (ogg/opus پیام‌رسان‌ها یا هر فرمتی که ffmpeg بشناسه) رو به متن
   * تبدیل می‌کنه. اگه گفتاری تشخیص داده نشه، رشته‌ی خالی برمی‌گردونه.
   */
  transcribe(audio: Buffer, extension = 'ogg', overrides: Partial<WhisperOptions> = {}): Promise<string> {
    // مدل whisper صریح (ارزیابی مدل‌های محلی با stt:eval) مستقیم محلیه
    return this.runTranscription(audio, extension, { ...this.defaults, ...overrides }, !!overrides.model);
  }

  /**
   * پیام صوتی یک گروه/کانال: اگه طولانی نباشه دانلود و به متن تبدیل می‌کنه.
   * اگه طولانی باشه یا هر خطایی رخ بده، رشته‌ی خالی برمی‌گردونه (و لاگ می‌کنه).
   */
  async transcribeVoice(
    durationSeconds: number,
    download: () => Promise<Buffer>,
    label: string,
  ): Promise<string> {
    if (durationSeconds > SpeechToTextService.MAX_DURATION_SECONDS) {
      this.logger.log(`⏭️ پیام صوتی طولانی رد شد (${durationSeconds} ثانیه): ${label}`);
      return '';
    }

    try {
      return await this.transcribe(await download(), 'ogg');
    } catch (error) {
      this.logger.error(`تبدیل پیام صوتی ناموفق بود: ${label}`, error as Error);
      return '';
    }
  }

  private async runTranscription(audio: Buffer, extension: string, options: WhisperOptions, localOnly: boolean): Promise<string> {
    if (options.vad && !this.vadModel) {
      this.logger.warn('مدل VAD پیدا نشد -- بدون VAD ادامه می‌ده (WHISPER_VAD_MODEL رو تنظیم کنید).');
    }

    await mkdir(this.workDir, { recursive: true });
    const id = randomUUID();
    const inputPath = join(this.workDir, `${id}.${extension}`);
    const wavPath = join(this.workDir, `${id}.wav`);

    try {
      await writeFile(inputPath, audio);

      // whisper فقط WAV مونوی ۱۶ کیلوهرتز می‌خونه.
      await execFileAsync(
        'ffmpeg',
        ['-y', '-loglevel', 'error', '-i', inputPath, '-af', AUDIO_FILTER, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wavPath],
        { timeout: SpeechToTextService.TIMEOUT_MS },
      );

      const startedAt = Date.now();
      const local = () => this.queue.run(() => this.runWhisper(wavPath, options));
      const heard = localOnly
        ? await local()
        : await transcribeSpeech(wavPath, { language: this.language, prompt: options.prompt }, local);

      const raw = heard.text.trim();
      const text = this.corrections.reduce(
        (current, rule) => current.replace(rule.from, rule.to),
        cleanTranscript(raw, options.prompt),
      );

      this.logger.log(`🎙️ تبدیل صدا به متن انجام شد (${heard.model}) -- ${Date.now() - startedAt}ms`);
      if (this.sampleDir) await this.keepSample(wavPath, raw, text, heard.model);
      return text;
    } finally {
      await rm(inputPath, { force: true }).catch(() => undefined);
      await rm(wavPath, { force: true }).catch(() => undefined);
    }
  }

  private async runWhisper(wavPath: string, options: WhisperOptions): Promise<Transcript> {
    const args = ['-m', this.modelPath(options.model), '-f', wavPath, '-l', this.language, '-t', String(this.threads), '-nt', '-np'];
    if (options.prompt) args.push('--prompt', options.prompt);
    if (options.vad && this.vadModel) args.push('--vad', '-vm', this.vadModel);

    const run = (extra: string[]) =>
      execFileAsync(this.whisperBinary, [...args, ...extra], {
        timeout: SpeechToTextService.TIMEOUT_MS,
        maxBuffer: 10 * 1024 * 1024,
      });
    // GPU با Ollama (qwen3) مشترکه و حافظه‌اش تنگه -- اگه whisper روی GPU جا
    // نشد، به‌جای از دست رفتن ویس، روی CPU (کندتر) دوباره اجرا می‌شه.
    const { stdout } = await run([]).catch((error) => {
      this.logger.warn(`whisper روی GPU ناموفق بود، اجرا روی CPU: ${(error as Error).message.slice(0, 200)}`);
      return run(['-ng']);
    });
    return { text: stdout.split('\n').map((line) => line.trim()).filter(Boolean).join(' '), model: basename(options.model) };
  }

  /** فایل X.got.txt رو با متن درستِ گفته‌شده به X.txt تغییر نام بدید تا stt:eval اون رو بسنجه. */
  private async keepSample(wavPath: string, raw: string, text: string, model: string): Promise<void> {
    try {
      await mkdir(this.sampleDir!, { recursive: true });
      const name = join(this.sampleDir!, new Date().toISOString().replace(/[:.]/g, '-'));
      await copyFile(wavPath, `${name}.wav`);
      await writeFile(`${name}.got.txt`, `raw: ${raw}\nfinal: ${text}\nmodel: ${model}\n`);
    } catch (error) {
      this.logger.warn(`نمونه‌ی صوتی ذخیره نشد: ${(error as Error).message}`);
    }
  }

  private modelPath(model: string): string {
    return isAbsolute(model) ? model : join(this.whisperDir, 'models', model);
  }

  private existingPath(model: string): string | null {
    const path = this.modelPath(model);
    return existsSync(path) ? path : null;
  }

  /**
   * prompt پیش‌فرض خاموشه: روی ۲۶ نمونه‌ی ارزیابی، prompt واژگان بار CER رو از
   * ۲۴.۷٪ به ۳۱.۳٪ بدتر کرد. WHISPER_PROMPT=file متن whisper_prompt.txt رو
   * فعال می‌کنه (برای ارزیابی دوباره روی ویس‌های واقعی کانال‌ها) و هر مقدار
   * دیگه‌ای خودش prompt می‌شه.
   */
  private defaultPrompt(): string {
    const fromEnv = process.env.WHISPER_PROMPT;
    if (!fromEnv || fromEnv === 'off') return '';
    return fromEnv === 'file' ? SpeechToTextService.filePrompt() : fromEnv;
  }

  static filePrompt(): string {
    try {
      return readFileSync(join(LOCAL_FILES, 'whisper_prompt.txt'), 'utf8').replace(/\s+/g, ' ').trim();
    } catch {
      return '';
    }
  }
}
