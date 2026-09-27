import { Injectable, Logger } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { cpus } from 'node:os';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { SerialTaskQueue } from '../common/serialTaskQueue';

const execFileAsync = promisify(execFile);

/**
 * تبدیل پیام صوتی به متن با whisper.cpp (محلی، بدون سرویس خارجی) -- مشترک
 * بین گروه/کانال‌های بار واتساپ و تلگرام و بات تلگرام.
 *
 * whisper روی CPU اجرا می‌شه و سنگینه، برای همین درخواست‌ها پشت‌سرهم
 * (نه هم‌زمان) اجرا می‌شن.
 */
@Injectable()
export class SpeechToTextService {
  private readonly logger = new Logger(SpeechToTextService.name);

  private readonly whisperDir = process.env.WHISPER_CPP_DIR || '/home/hamed/whisper.cpp';
  private readonly whisperBinary = join(this.whisperDir, 'build', 'bin', 'whisper-cli');
  private readonly modelPath =
    process.env.WHISPER_MODEL_PATH || join(this.whisperDir, 'models', 'ggml-large-v3-q5_0.bin');
  private readonly language = process.env.WHISPER_LANGUAGE || 'fa';
  // نصف هسته‌ها -- بقیه برای خود برنامه و Ollama آزاد می‌مونه.
  private readonly threads = Math.max(4, Math.floor(cpus().length / 2));
  // داخل پروژه، نه /tmp: ffmpeg نصب‌شده با snap یک /tmp خصوصی داره و فایل‌های
  // /tmp برنامه رو نمی‌بینه.
  private readonly workDir = process.env.VOICE_WORK_DIR || join(process.cwd(), 'uploads', 'voice-tmp');

  /** پیام‌های صوتی طولانی‌تر از این (ثانیه) پردازش نمی‌شن تا صف قفل نشه. */
  static readonly MAX_DURATION_SECONDS = Number(process.env.VOICE_MAX_DURATION_SECONDS) || 180;
  private static readonly TIMEOUT_MS = 5 * 60 * 1000;

  private readonly queue = new SerialTaskQueue();

  /**
   * فایل صوتی (ogg/opus واتساپ و تلگرام یا هر فرمتی که ffmpeg بشناسه) رو
   * به متن تبدیل می‌کنه. اگه صدایی تشخیص داده نشه، رشته‌ی خالی برمی‌گردونه.
   */
  transcribe(audio: Buffer, extension = 'ogg'): Promise<string> {
    return this.queue.run(() => this.runTranscription(audio, extension));
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

  private async runTranscription(audio: Buffer, extension: string): Promise<string> {
    await mkdir(this.workDir, { recursive: true });
    const id = randomUUID();
    const inputPath = join(this.workDir, `${id}.${extension}`);
    const wavPath = join(this.workDir, `${id}.wav`);

    try {
      await writeFile(inputPath, audio);

      // whisper فقط WAV مونوی ۱۶ کیلوهرتز می‌خونه.
      await execFileAsync(
        'ffmpeg',
        ['-y', '-loglevel', 'error', '-i', inputPath, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wavPath],
        { timeout: SpeechToTextService.TIMEOUT_MS },
      );

      const startedAt = Date.now();
      const { stdout } = await execFileAsync(
        this.whisperBinary,
        ['-m', this.modelPath, '-f', wavPath, '-l', this.language, '-t', String(this.threads), '-nt', '-np'],
        { timeout: SpeechToTextService.TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 },
      );

      const text = stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .join(' ')
        .trim();

      this.logger.log(`🎙️ تبدیل صدا به متن انجام شد -- ${Date.now() - startedAt}ms`);
      return text;
    } finally {
      await rm(inputPath, { force: true }).catch(() => undefined);
      await rm(wavPath, { force: true }).catch(() => undefined);
    }
  }
}
