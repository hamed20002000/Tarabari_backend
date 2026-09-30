export const CHANNEL_PLATFORMS = ['whatsapp', 'telegram', 'bale', 'rubika'] as const;
export type ChannelPlatform = (typeof CHANNEL_PLATFORMS)[number];

/** پلتفرم‌هایی که با اکانت کاربری و لینک عضو می‌شن (همه به‌جز واتساپ). */
export type AccountPlatform = Exclude<ChannelPlatform, 'whatsapp'>;

/**
 * سوییچ عضویت و گوش دادن به گروه/کانال‌ها برای هر پلتفرم. مقدار
 * CHANNEL_MONITORING_ENABLED:
 *   true یا خالی  -- همه‌ی پلتفرم‌ها فعال (پیش‌فرض)
 *   false         -- هیچ‌کدوم
 *   اسم پلتفرم‌ها -- فقط همون‌ها، با کاما (مثلاً telegram,bale)
 * وقتی پلتفرمی خاموشه، برنامه عضو هیچ گروه/کانالی از اون نمی‌شه و پیام‌هاش
 * پردازش نمی‌شه -- ثبت لینک‌ها از API همچنان کار می‌کنه.
 */
export function isChannelMonitoringEnabled(platform: ChannelPlatform): boolean {
  const value = process.env.CHANNEL_MONITORING_ENABLED?.trim().toLowerCase();
  if (!value || value === 'true') return true;
  if (value === 'false') return false;
  return value.split(',').map((item) => item.trim()).includes(platform);
}
