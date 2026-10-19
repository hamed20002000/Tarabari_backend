import { createHash } from 'crypto';

/**
 * یکسان‌سازی متن فارسی برای مقایسه: ی/ک عربی به فارسی، ارقام فارسی/عربی به
 * لاتین، حذف کاراکترهای نامرئی و فاصله‌های اضافه، و حروف کوچک. هم برای هش
 * پیام تکراری و هم برای match کردن فیلترهای subscriber استفاده می‌شه.
 */
export function normalizePersianText(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[​-‏‪-‮⁦-⁩﻿]/g, '')
    .replace(/[يى]/g, 'ی')
    .replace(/ك/g, 'ک')
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * هش متن برای تشخیص آگهی تکراری: علاوه بر normalizePersianText، ایموجی،
 * علامت‌ها و فاصله‌ها هم حذف می‌شن -- پست دوباره با فاصله/ایموجی متفاوت هم
 * همون هش رو می‌ده.
 */
export function cargoTextHash(text: string): string {
  const core = normalizePersianText(text).replace(/[^\p{L}\p{N}]+/gu, '');
  return createHash('sha256').update(core).digest('hex');
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const compact = (text: string | null | undefined) => normalizePersianText(text ?? '').replace(/[^\p{L}\p{N}]+/gu, '');

/**
 * هش خط‌های پیام برای تشخیص لیست تقریباً تکراری (مثل «Auto Reply» کارگزارها که
 * همون لیست بار رو با تغییر کوچکی دوباره می‌فرستن). خطی که حرف نداره (ساعت، تاریخ،
 * خط جداکننده) حساب نمی‌شه تا تغییرش پیام رو «تازه» نکنه. پیشوند line: تا با هش
 * کل متن و هش بار در یک جدول قاطی نشه.
 */
export function cargoLineHashes(text: string): string[] {
  const lines = text
    .split(/\r?\n/)
    .map(compact)
    .filter((line) => /\p{L}/u.test(line));
  return [...new Set(lines.map((line) => sha256(`line:${line}`)))];
}

/**
 * هش یک بار برای تشخیص بار تکراری از متن‌های مختلف: مبدا، مقصد، نوع بار، وزن و
 * خودرو، به‌علاوه‌ی شماره‌های تماس پیام -- همون مسیر از دو کارگزار مختلف دو بار حساب می‌شه.
 */
export function cargoLoadHash(
  load: { origin?: string | null; destination?: string | null; cargo_type?: string | null; weight?: string | null; vehicle_type?: string | null },
  phoneNumbers: string[],
): string {
  const phones = [...new Set(phoneNumbers.map((phone) => compact(phone).replace(/\D/g, '').slice(-10)).filter(Boolean))].sort();
  const fields = [load.origin, load.destination, load.cargo_type, load.weight, load.vehicle_type].map(compact);
  return sha256(`load:${fields.join('|')}|${phones.join(',')}`);
}
