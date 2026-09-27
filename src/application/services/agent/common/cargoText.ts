import { CargoOrderExtraction } from '../services/aiTools.service';

export const CHANNEL_REPLACEMENT_NUMBER = '09394113259'; // بهتره از config/env بیاد

/**
 * متن نهایی یک سفارش بار (برای توزیع‌کننده) -- مشترک بین واتساپ و تلگرام
 * تا خروجی هر دو پلتفرم یکسان باشه.
 */
export function buildCargoProcessedText(
  data: CargoOrderExtraction,
  replacementNumber: string,
  orderCode?: string,
): string {
  if (!data.is_cargo_order) {
    return '';
  }

  const lines: string[] = [];

  if (data.cargo_type) {
    lines.push(`بار: ${data.cargo_type}`);
  }

  if (data.origin && data.destination) {
    lines.push(`مسیر: ${data.origin} به ${data.destination}`);
  } else if (data.origin) {
    lines.push(`مبدا: ${data.origin}`);
  } else if (data.destination) {
    lines.push(`مقصد: ${data.destination}`);
  }

  if (data.weight) {
    lines.push(`وزن: ${data.weight}`);
  }

  if (data.vehicle_type) {
    lines.push(`نوع خودرو: ${data.vehicle_type}`);
  }

  if (data.price) {
    lines.push(`قیمت: ${data.price}`);
  }

  const phoneRelatedPattern = /تلفن|تماس|شماره/;
  if (data.extra_notes && !phoneRelatedPattern.test(data.extra_notes)) {
    lines.push(data.extra_notes);
  }

  lines.push('');
  lines.push(`شماره تماس: ${replacementNumber}`);

  if (orderCode) {
    lines.push(`کد پیگیری: ${orderCode}`);
  }

  return lines.join('\n');
}
