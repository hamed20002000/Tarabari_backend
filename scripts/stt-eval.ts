/**
 * ارزیابی تبدیل صدا به متن با همون SpeechToTextService واقعی:
 *
 *   npm run stt:eval -- --samples <پوشه> [--model ggml-large-v3.bin] [--prompt both] [--vad both]
 *
 * نمونه‌ها: هر فایل صوتی (ogg، webm، wav، m4a، mp3) کنار یک فایل هم‌نام .txt
 * که متن درستِ گفته‌شده توشه. معیار CER (درصد حروف اشتباه) است؛ فاصله، علائم
 * و فرق رقم فارسی/لاتین حساب نمی‌شه، ولی عدد به حروف در برابر رقم خطاست.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { config } from 'dotenv';
import { SpeechToTextService } from '../src/application/services/agent/services/speechToText.service';
import { normalizePersianText } from '../src/application/services/agent/utils/persianText';

const AUDIO = new Set(['.ogg', '.oga', '.opus', '.webm', '.wav', '.m4a', '.mp3']);
const norm = (text: string) => normalizePersianText(text).replace(/[^\p{L}\p{N}]/gu, '');

function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const current = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = current;
    }
  }
  return row[b.length];
}

const arg = (name: string) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const modes = (value: string | undefined, fallback: boolean) =>
  value === 'both' ? [false, true] : value ? [value === 'on'] : [fallback];

async function main(): Promise<void> {
  config();
  const dir = arg('samples') ?? join(process.cwd(), 'stt-samples');
  const samples = existsSync(dir)
    ? readdirSync(dir)
        .filter((file) => AUDIO.has(extname(file).toLowerCase()))
        .map((file) => ({ audio: join(dir, file), expected: join(dir, `${basename(file, extname(file))}.txt`) }))
        .filter((sample) => existsSync(sample.expected))
    : [];
  if (!samples.length) throw new Error(`نمونه‌ای در ${dir} نیست -- فایل صوتی + فایل .txt هم‌نام`);

  const speech = new SpeechToTextService();
  const model = arg('model');

  for (const prompt of modes(arg('prompt'), false)) {
    for (const vad of modes(arg('vad'), speech.vadAvailable)) {
      const label = `${model ?? 'default model'} / prompt ${prompt ? 'on' : 'off'} / VAD ${vad ? 'on' : 'off'}`;
      let errors = 0;
      let chars = 0;
      const started = Date.now();
      console.log(`\n=== ${label}`);
      for (const sample of samples) {
        const expected = readFileSync(sample.expected, 'utf8').trim();
        const got = await speech.transcribe(readFileSync(sample.audio), extname(sample.audio).slice(1), {
          ...(model ? { model } : {}),
          prompt: prompt ? SpeechToTextService.filePrompt() : '',
          vad,
        });
        const distance = editDistance(norm(expected), norm(got));
        errors += distance;
        chars += norm(expected).length;
        const cer = (100 * distance) / Math.max(norm(expected).length, 1);
        console.log(`${cer.toFixed(0).padStart(4)}%  ${basename(sample.audio)}\n       expected: ${expected}\n       got     : ${got}`);
      }
      const seconds = (Date.now() - started) / 1000;
      console.log(`--- ${label}: CER ${((100 * errors) / Math.max(chars, 1)).toFixed(1)}%  (${seconds.toFixed(0)}s for ${samples.length} samples)`);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
