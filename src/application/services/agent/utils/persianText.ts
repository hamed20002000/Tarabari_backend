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
