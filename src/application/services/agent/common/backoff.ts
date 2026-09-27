/** فاصله‌ی تلاش بعدی (دقیقه) به‌صورت نمایی: base، 2×base، 4×base، ... تا سقف max. */
export function exponentialBackoffMinutes(
  retryCount: number,
  baseMinutes: number,
  maxMinutes: number,
): number {
  return Math.min(baseMinutes * Math.pow(2, Math.max(0, retryCount - 1)), maxMinutes);
}
