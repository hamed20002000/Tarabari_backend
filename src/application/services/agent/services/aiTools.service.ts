import { readFileSync } from 'fs';
import { join } from 'path';
import { z } from 'zod';
import { Injectable } from '@nestjs/common';
import { SerialTaskQueue } from '../common/serialTaskQueue';
import { llmChat, LlmChatRequest } from '../common/llmClient';

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

const GENERIC_CARGO_TYPES = new Set(['بار', 'باره', 'بارها', 'بارِ', 'محموله']);

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
  // صف سراسری مدل محلی -- واتساپ و تلگرام هر دو از همین یک نمونه
  // (CargoDetectionModule) استفاده می‌کنن، پس درخواست‌هاشون به Ollama
  // پشت‌سرهم اجرا می‌شن، نه هم‌زمان (که باعث timeout می‌شد). OpenAI صف نداره.
  private readonly modelQueue = new SerialTaskQueue();

  /** تعداد درخواست‌هایی که الان در صف مدل محلی هستن (شامل درخواست در حال اجرا). */
  get pendingCount(): number {
    return this.modelQueue.pending;
  }

  private readonly PROMPT_PATH = join(
    process.cwd(),
    'src/application/services/agent/prompts/selector.prompt',
  );
  // درخواست‌ها پشت‌سرهم اجرا می‌شن، پس این مهلت فقط زمان پردازش خود مدله
  // (حدود ۳۵-۶۰ ثانیه روی این GPU)؛ ۶۰ ثانیه کم بود و پیام‌ها از دست می‌رفتن.
  private readonly REQUEST_TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS) || 180000;
  // پرامپت سیستم به‌تنهایی ~۳۸۰۰ توکنه؛ با context پیش‌فرض ۴۰۹۶، متن پیام و
  // JSON خروجی جا نمی‌شدن و Ollama ورودی رو می‌برید.
  private readonly CONTEXT_LENGTH = 8192;

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
    return this.runDetection(prompt);
  }

  private async runDetection(prompt: string): Promise<CargoOrderExtraction> {
    const systemContent = this.loadSystemPrompt();

    const request: LlmChatRequest = {
      messages: [
        { role: 'system', content: systemContent },
        { role: 'user', content: prompt },
      ],
      think: false, // غیرفعال کردن تفکر داخلی -- تقریباً نصف می‌کنه زمان پاسخ رو
      // بعد از ۵ دقیقه بی‌کاری (پیش‌فرض) مدل از حافظه خارج و اولین پیام بعدی با
      // لود دوباره کند می‌شد.
      keepAlive: '30m',
      options: {
        num_ctx: this.CONTEXT_LENGTH,
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
      timeoutMs: this.REQUEST_TIMEOUT_MS,
    };

    // اول OpenAI؛ مدل محلی (اگه LLM_LOCAL_FALLBACK خاموش نباشه) پشت صف
    const rawContent = await llmChat(request, (task) => this.modelQueue.run(task));

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
      // خود کلمه‌ی «بار» نوع بار نیست («بار: بار» در اعلان بی‌معنیه) -- مدل گاهی برش می‌داره.
      if (cleaned.cargo_type && GENERIC_CARGO_TYPES.has(cleaned.cargo_type.trim())) cleaned.cargo_type = null;
      return cleaned;
    });

    // فقط فیلدهای خام برمی‌گرده -- ساخت متن نهایی (با کد سفارش) بر عهده‌ی
    // فراخواننده‌ست، چون اون به orderNumber دیتابیس دسترسی داره.
    return { ...data, loads };
  }
}

export { TransportOrderService, CargoExtractionSchema, CargoLoadSchema };