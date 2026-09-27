/**
 * شناسه‌های اخیراً دیده‌شده با سقف حافظه -- برای جلوگیری از پردازش دوباره‌ی
 * پیام‌های تکراری (redelivery). با پر شدن، قدیمی‌ترین شناسه حذف می‌شه.
 */
export class RecentIdCache<T = string> {
  private readonly ids = new Set<T>();

  constructor(private readonly limit: number) { }

  has(id: T): boolean {
    return this.ids.has(id);
  }

  add(id: T): void {
    this.ids.add(id);
    if (this.ids.size > this.limit) {
      // Set ترتیب درج رو نگه می‌داره -- اولین عضو قدیمی‌ترینه.
      const oldest = this.ids.values().next().value;
      if (oldest !== undefined) this.ids.delete(oldest);
    }
  }
}
