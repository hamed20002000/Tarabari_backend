export type MonitoringPlatform = 'whatsapp' | 'telegram';

/**
 * سوییچ عضویت و گوش دادن به گروه/کانال‌ها برای هر پلتفرم. مقدار
 * CHANNEL_MONITORING_ENABLED:
 *   true یا خالی         -- هر دو پلتفرم فعال (پیش‌فرض)
 *   false                -- هیچ‌کدوم
 *   telegram / whatsapp  -- فقط همون پلتفرم (یا هر دو با کاما: telegram,whatsapp)
 * وقتی پلتفرمی خاموشه، برنامه عضو هیچ گروه/کانالی از اون نمی‌شه و پیام‌هاش
 * پردازش نمی‌شه -- ثبت لینک‌ها از API همچنان کار می‌کنه.
 */
export function isChannelMonitoringEnabled(platform: MonitoringPlatform): boolean {
  const value = process.env.CHANNEL_MONITORING_ENABLED?.trim().toLowerCase();
  if (!value || value === 'true') return true;
  if (value === 'false') return false;
  return value.split(',').map((item) => item.trim()).includes(platform);
}
