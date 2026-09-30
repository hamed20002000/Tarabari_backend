import { TelegramClientParams } from 'telegram/client/telegramBaseClient';

export function getTelegramApiCredentials(): { apiId: number; apiHash: string } | null {
  const apiId = Number(process.env.TELEGRAM_API_ID);
  const apiHash = process.env.TELEGRAM_API_HASH;
  if (!apiId || !apiHash) return null;
  return { apiId, apiHash };
}

/**
 * تنظیمات اتصال GramJS -- هم اسکریپت لاگین و هم سرویس از همین استفاده
 * می‌کنن. ثابت موندن مشخصات دستگاه بین لاگین و اجرا مهمه: اگه یک نشست
 * با مشخصات متفاوت وصل بشه، برای تلگرام مشکوک به نظر می‌رسه.
 */
export function buildTelegramClientParams(): TelegramClientParams {
  return {
    connectionRetries: 10,
    autoReconnect: true,
    // FloodWaitهای کوتاه (تا ۶۰ ثانیه) خودکار صبر می‌شن؛ بلندترها خطا
    // می‌دن تا سرویس خودش کل عملیات عضویت رو متوقف کنه.
    floodSleepThreshold: 60,
    deviceModel: process.env.TELEGRAM_DEVICE_MODEL || 'Desktop',
    systemVersion: process.env.TELEGRAM_SYSTEM_VERSION || 'Linux x86_64',
    appVersion: process.env.TELEGRAM_APP_VERSION || '5.6.3 x64',
    langCode: 'fa',
    systemLangCode: 'fa-IR',
  };
}
