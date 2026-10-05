import { readFileSync } from 'fs';
import { join } from 'path';
import axios from 'axios';
import { z } from 'zod';
import { Injectable } from '@nestjs/common';
import { SerialTaskQueue } from '../common/serialTaskQueue';

// ------------------------------------------------------------------
// Schema خروجی خام مدل -- فقط فیلدهای استخراج‌شده، بدون متن نهایی.
// مدل هرگز متن نمایشی نمی‌سازد؛ فقط داده‌ی ساختاریافته تولید می‌کند.
// یک پیام ممکن است چند بار (چند مسیر مستقل) داشته باشد -- هر کدام یک
// عضو loads است و جداگانه ذخیره و با کد پیگیری خودش منتشر می‌شود.
// ------------------------------------------------------------------
const CargoLoadSchema = z.object({
  origin: z.string().nullable(),
  destination: z.string().nullable(),
  cargo_type: z.string().nullable(),
  weight: z.string().nullable(),
  vehicle_type: z.string().nullable(),
  price: z.string().nullable(),
  extra_notes: z.string().nullable(),
});

const CargoExtractionSchema = z.object({
  is_cargo_order: z.boolean(),
  confidence: z.number().min(0).max(1),
  found_phone_numbers: z.array(z.string()),
  loads: z.array(CargoLoadSchema),
});

/** یک بار (یک مسیر مبدا-مقصد مستقل) داخل پیام. */
export type CargoLoad = z.infer<typeof CargoLoadSchema>;

// ------------------------------------------------------------------
// خروجی نهایی متد استخراج -- فقط فیلدهای خام، بدون متن نهایی. ساخت متن
// نهایی (با کد پیگیری) بر عهده‌ی CargoPipelineService است. این سرویس فقط
// مسئول فراخوانی مدل و اعتبارسنجی خروجیه، هیچ منطق کسب‌وکاری دیگری
// اینجا نباید باشد.
// ------------------------------------------------------------------
export type CargoOrderExtraction = z.infer<typeof CargoExtractionSchema>;

@Injectable()
class TransportOrderService {
  // صف سراسری فراخوانی مدل -- واتساپ و تلگرام هر دو از همین یک نمونه
  // (CargoDetectionModule) استفاده می‌کنن، پس درخواست‌هاشون به Ollama
  // پشت‌سرهم اجرا می‌شن، نه هم‌زمان (که باعث timeout می‌شد).
  private readonly modelQueue = new SerialTaskQueue();

  /** تعداد درخواست‌هایی که الان در صف مدل هستن (شامل درخواست در حال اجرا). */
  get pendingCount(): number {
    return this.modelQueue.pending;
  }

  private readonly PROMPT_PATH = join(
    process.cwd(),
    'src/application/services/agent/prompts/selector.prompt',
  );
  private readonly OLLAMA_URL = 'http://localhost:11434/api/chat';
  private readonly MODEL = 'qwen3:8b';
  private readonly REQUEST_TIMEOUT_MS = 60000;

  private loadSystemPrompt(): string {
    try {
      return readFileSync(this.PROMPT_PATH, 'utf8');
    } catch (err) {
      throw new Error(
        `خطا در خواندن فایل پرامپت (${this.PROMPT_PATH}): ${(err as Error).message}`,
      );
    }
  }

  DetermineTextIsTransportOrder(prompt: string): Promise<CargoOrderExtraction> {
    return this.modelQueue.run(() => this.runDetection(prompt));
  }

  private async runDetection(prompt: string): Promise<CargoOrderExtraction> {
    const systemContent = this.loadSystemPrompt();

    const ollamaReq = {
      model: this.MODEL,
      messages: [
        { role: 'system', content: systemContent },
        { role: 'user', content: prompt },
      ],
      stream: false,
      think: false, // غیرفعال کردن تفکر داخلی -- تقریباً نصف می‌کنه زمان پاسخ رو
      options: {
        temperature: 0,
        repeat_penalty: 1.1,
      },
      format: {
        type: 'object',
        properties: {
          is_cargo_order: { type: 'boolean' },
          confidence: { type: 'number' },
          found_phone_numbers: { type: 'array', items: { type: 'string' } },
          loads: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                origin: { type: ['string', 'null'] },
                destination: { type: ['string', 'null'] },
                cargo_type: { type: ['string', 'null'] },
                weight: { type: ['string', 'null'] },
                vehicle_type: { type: ['string', 'null'] },
                price: { type: ['string', 'null'] },
                extra_notes: { type: ['string', 'null'] },
              },
              required: [
                'origin',
                'destination',
                'cargo_type',
                'weight',
                'vehicle_type',
                'price',
                'extra_notes',
              ],
            },
          },
        },
        required: ['is_cargo_order', 'confidence', 'found_phone_numbers', 'loads'],
      },
    };

    let rawContent: string;
    try {
      const resp = await axios.post(this.OLLAMA_URL, ollamaReq, {
        headers: { 'Content-Type': 'application/json' },
        timeout: this.REQUEST_TIMEOUT_MS,
      });
      rawContent = resp.data.message.content;
    } catch (err) {
      if (axios.isAxiosError(err)) {
        throw new Error(
          `خطا در اتصال به Ollama (${this.OLLAMA_URL}): ${err.message}`,
        );
      }
      throw new Error(`خطای ناشناخته در درخواست به مدل: ${(err as Error).message}`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawContent);
    } catch (err) {
      throw new Error(
        `پاسخ مدل JSON معتبر نبود: ${rawContent.slice(0, 200)}...`,
      );
    }

    const validation = CargoExtractionSchema.safeParse(parsed);
    if (!validation.success) {
      throw new Error(
        `ساختار خروجی مدل با schema مطابقت ندارد: ${validation.error.message}`,
      );
    }

    // «بار هست» بدون هیچ بار استخراج‌شده، یا بار استخراج‌شده با «بار نیست» --
    // هر دو یعنی پیام بار نیست؛ ناسازگاری مدل نباید رکورد خالی یا بار گم‌شده بسازه.
    const data = validation.data;
    if (!data.is_cargo_order || data.loads.length === 0) {
      return { ...data, is_cargo_order: false, loads: [] };
    }

    // مدل گاهی به‌جای null رشته‌ی خالی می‌ده -- برای توزیع‌کننده یکسان می‌شه.
    const loads = data.loads.map((load) => {
      const cleaned = { ...load };
      for (const key of Object.keys(cleaned) as (keyof CargoLoad)[]) {
        if (!cleaned[key]?.trim()) cleaned[key] = null;
      }
      return cleaned;
    });

    // فقط فیلدهای خام برمی‌گرده -- ساخت متن نهایی (با کد سفارش) بر عهده‌ی
    // فراخواننده‌ست، چون اون به orderNumber دیتابیس دسترسی داره.
    return { ...data, loads };
  }
}

export { TransportOrderService, CargoExtractionSchema, CargoLoadSchema };