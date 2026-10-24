import { Logger } from '@nestjs/common';
import axios, { AxiosError } from 'axios';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

/**
 * تنها جایی که مدل‌ها صدا زده می‌شن (همون ساختار llmClient در transport_backend): اول
 * OpenAI، اگه جواب نداد مدل محلی -- یا با LLM_LOCAL_FALLBACK=off، LlmUnavailableError.
 * بعد از قطعی (شبکه، تایم‌اوت، 5xx، 429، کلید نامعتبر) تا OPENAI_RETRY_AFTER_MS سراغ OpenAI
 * نمی‌ره، بعد دوباره امتحان می‌کنه.
 *   OPENAI_ENABLED=off  فعلاً فقط مدل محلی (کلید و مدل‌ها تنظیم می‌مونن؛ on یا پاک کردن خط = اول OpenAI)
 *   OPENAI_API_KEY      بدون اون (یا بدون مدل) همه‌چیز محلیه
 *   OPENAI_MODEL        استخراج بار
 *   OPENAI_STT_MODEL    ویس به متن
 *   OPENAI_BASE_URL     پیش‌فرض https://api.openai.com/v1 (برای relay/پراکسی)
 *   OPENAI_TIMEOUT_MS   پیش‌فرض 60000؛ OPENAI_STT_TIMEOUT_MS پیش‌فرض 30000
 *   OLLAMA_URL          پایه‌ی سرور محلی (پیش‌فرض http://localhost:11434)؛ LLM_MODEL پیش‌فرض qwen3:8b
 * env موقع فراخوانی خونده می‌شه نه موقع import: ConfigModule فایل .env رو بعد از import
 * شدن سرویس‌ها بار می‌کنه.
 */

const logger = new Logger('LlmClient');

export interface LlmChatRequest {
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[];
  /** JSON schema خروجی */
  format?: Record<string, unknown>;
  think?: boolean;
  /** تنظیمات Ollama؛ از این‌ها فقط temperature و top_p به OpenAI می‌رن */
  options?: Record<string, unknown>;
  /** keep_alive مدل محلی */
  keepAlive?: string;
  timeoutMs?: number;
}

/** هیچ مدلی برای جواب دادن در دسترس نیست. */
export class LlmUnavailableError extends Error {
  constructor() {
    super('در حال حاضر انجام این عملیات ممکن نیست؛ لطفاً کمی بعد دوباره تلاش کنید.');
    this.name = 'LlmUnavailableError';
  }
}

/** کار مدل محلی رو اجرا می‌کنه -- مثلاً پشت صف، چون GPU بین Ollama و whisper مشترکه. */
export type LocalRunner = <T>(task: () => Promise<T>) => Promise<T>;

const runNow: LocalRunner = (task) => task();

// OPENAI_ENABLED=off یعنی «فقط محلی»، پس مدل محلی همیشه جواب می‌ده
const localFallback = (): boolean => process.env.LLM_LOCAL_FALLBACK !== 'off' || process.env.OPENAI_ENABLED === 'off';

const llmModel = (): string => process.env.LLM_MODEL || 'qwen3:8b';

function ollamaBase(): string {
  return (process.env.OLLAMA_URL || 'http://localhost:11434').replace(/\/+$/, '').replace(/\/api\/chat$/, '');
}

// تا این لحظه (epoch ms) OpenAI امتحان نمی‌شه -- مشترک بین استخراج بار و ویس
let openAiDownUntil = 0;

interface OpenAiConfig {
  key: string;
  model: string;
  baseUrl: string;
  timeoutMs: number;
  retryAfterMs: number;
}

/** null یعنی OpenAI برای این کار تنظیم نشده (کلید یا مدلش نیست). */
function openAiConfig(model: string | undefined, timeoutMs: number): OpenAiConfig | null {
  const key = process.env.OPENAI_API_KEY;
  if (process.env.OPENAI_ENABLED === 'off' || !key || !model) return null;
  return {
    key,
    model,
    baseUrl: (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, ''),
    timeoutMs,
    retryAfterMs: Number(process.env.OPENAI_RETRY_AFTER_MS) || 60_000,
  };
}

// قطعی یا مشکل حساب (نه ایراد همین یک درخواست) -- تا مدتی سراغ OpenAI نمی‌ریم
function isOutage(error: unknown): boolean {
  const status = (error as AxiosError)?.response?.status;
  return status === undefined || status >= 500 || [401, 403, 404, 408, 429].includes(status);
}

async function openAiFirst<T>(config: OpenAiConfig | null, openAi: (config: OpenAiConfig) => Promise<T>, local: () => Promise<T>): Promise<T> {
  if (config && Date.now() >= openAiDownUntil) {
    try {
      const result = await openAi(config);
      if (openAiDownUntil) logger.log('OpenAI is answering again');
      openAiDownUntil = 0;
      return result;
    } catch (error) {
      const status = (error as AxiosError)?.response?.status;
      const reason = status ? `HTTP ${status}` : (error as Error).message;
      if (isOutage(error)) {
        openAiDownUntil = Date.now() + config.retryAfterMs;
        logger.warn(`OpenAI unavailable (${reason}); not tried for the next ${config.retryAfterMs / 1000}s`);
      } else {
        // ایراد همین درخواست (مثلاً schema یا فایل صوتی) -- باید دیده بشه
        logger.error(`OpenAI rejected the request (${reason}): ${JSON.stringify((error as AxiosError).response?.data)}`);
      }
    }
  }
  if (!localFallback()) throw new LlmUnavailableError();
  return local();
}

/**
 * مهلت قطعی یه درخواست به OpenAI، با برقراری اتصال: timeout خود axios فقط بعد از وصل شدن شمرده می‌شه
 * و اتصالی که وسط برقرار شدن گیر کنه («connect ETIMEDOUT») تا چند دقیقه منتظر می‌مونه.
 */
async function withDeadline<T>(ms: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const deadline = AbortSignal.timeout(ms);
  try {
    return await run(deadline);
  } catch (error) {
    if (deadline.aborted) throw new Error(`no answer within ${ms}ms`);
    throw error;
  }
}

// مدل‌های استدلالی (reasoning) temperature/top_p رو رد می‌کنن؛ بعد از اولین رد، برای اون مدل فرستاده نمی‌شن
const modelsWithoutSampling = new Set<string>();

const rejectsSampling = (error: unknown) => {
  const response = (error as AxiosError<{ error?: { param?: string } }>)?.response;
  return response?.status === 400 && ['temperature', 'top_p'].includes(response.data?.error?.param ?? '');
};

async function openAiChat(request: LlmChatRequest, config: OpenAiConfig): Promise<string> {
  const { messages, format, options, timeoutMs } = request;
  const wait = Math.min(config.timeoutMs, timeoutMs || Infinity);
  const send = () =>
    withDeadline(wait, (signal) => axios.post(
      `${config.baseUrl}/chat/completions`,
      {
        model: config.model,
        messages,
        ...(format && {
          // strict نه: حالت strict شرط‌هایی (additionalProperties: false) داره که schemaها ندارن
          response_format: { type: 'json_schema', json_schema: { name: 'output', schema: format, strict: false } },
        }),
        ...(!modelsWithoutSampling.has(config.model) && {
          ...(typeof options?.temperature === 'number' && { temperature: options.temperature }),
          ...(typeof options?.top_p === 'number' && { top_p: options.top_p }),
        }),
      },
      {
        headers: { Authorization: `Bearer ${config.key}` },
        timeout: wait,
        signal,
      },
    ));
  let response;
  try {
    response = await send();
  } catch (error) {
    if (!rejectsSampling(error) || modelsWithoutSampling.has(config.model)) throw error;
    modelsWithoutSampling.add(config.model);
    logger.log(`${config.model} does not take temperature/top_p; sending without them`);
    response = await send();
  }
  return response.data?.choices?.[0]?.message?.content ?? '';
}

async function ollamaChat(request: LlmChatRequest): Promise<string> {
  const { keepAlive, timeoutMs, ...body } = request;
  const response = await axios.post(
    `${ollamaBase()}/api/chat`,
    { model: llmModel(), stream: false, ...body, ...(keepAlive && { keep_alive: keepAlive }) },
    { timeout: timeoutMs },
  );
  return response.data?.message?.content ?? '';
}

/** متن پاسخ مدل؛ timeoutMs درخواست فقط برای مدل محلیه (OpenAI: OPENAI_TIMEOUT_MS). */
export async function llmChat(request: LlmChatRequest, runLocal: LocalRunner = runNow): Promise<string> {
  return openAiFirst(
    openAiConfig(process.env.OPENAI_MODEL, Number(process.env.OPENAI_TIMEOUT_MS) || 60_000),
    (config) => openAiChat({ ...request, timeoutMs: undefined }, config),
    () => runLocal(() => ollamaChat(request)),
  );
}

export interface Transcript {
  /** متن خام مدل، قبل از پاک‌سازی و اصلاح */
  text: string;
  /** مدلی که متن رو ساخت (برای نمونه‌های آموزش/ارزیابی) */
  model: string;
}

/** ویس (WAV آماده) به متن: اول OpenAI (OPENAI_STT_MODEL)، بعد local (whisper.cpp). */
export async function transcribeSpeech(
  audioPath: string,
  options: { language: string; prompt: string },
  local: () => Promise<Transcript>,
): Promise<Transcript> {
  return openAiFirst(
    openAiConfig(process.env.OPENAI_STT_MODEL, Number(process.env.OPENAI_STT_TIMEOUT_MS) || 30_000),
    async (config) => {
      const form = new FormData();
      form.append('file', new Blob([await readFile(audioPath)]), basename(audioPath));
      form.append('model', config.model);
      form.append('language', options.language);
      if (options.prompt) form.append('prompt', options.prompt);
      form.append('response_format', 'json');
      const response = await withDeadline(config.timeoutMs, (signal) =>
        axios.post(`${config.baseUrl}/audio/transcriptions`, form, {
          headers: { Authorization: `Bearer ${config.key}` },
          timeout: config.timeoutMs,
          signal,
        }),
      );
      return { text: response.data?.text ?? '', model: `openai/${config.model}` };
    },
    local,
  );
}

/** فقط برای تست: وضعیت قطعی OpenAI رو صفر می‌کنه. */
export function resetOpenAiState(): void {
  openAiDownUntil = 0;
  modelsWithoutSampling.clear();
}
