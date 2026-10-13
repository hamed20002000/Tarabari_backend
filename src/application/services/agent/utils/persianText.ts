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
