import { CargoLoad } from '../services/aiTools.service';

/**
 * متن نهایی یک بار (یکی از loads پیام، برای توزیع‌کننده) -- مشترک بین همه‌ی پلتفرم‌ها
 * تا خروجی هر دو پلتفرم یکسان باشه. شماره‌ی تماس اینجا نوشته نمی‌شه:
 * transport_backend شماره‌ی هر ثبت‌کننده (User.mobile) رو خودش اضافه می‌کنه.
 */
export function buildCargoProcessedText(
  data: CargoLoad,
  orderCode?: string,
): string {
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

  if (orderCode) {
    lines.push(`کد پیگیری: ${orderCode}`);
  }

  return lines.join('\n');
}
