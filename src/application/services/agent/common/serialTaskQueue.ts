/**
 * کارها رو یکی‌یکی و به ترتیب ورود اجرا می‌کنه (نه هم‌زمان). خطای یک کار
 * صف رو برای کارهای بعدی خراب نمی‌کنه -- فقط به فراخواننده‌ی همون کار برمی‌گرده.
 */
export class SerialTaskQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private pendingCount = 0;

  /** تعداد کارهای داخل صف (شامل کار در حال اجرا). */
  get pending(): number {
    return this.pendingCount;
  }

  run<T>(task: () => Promise<T>): Promise<T> {
    this.pendingCount += 1;
    const result = this.tail.then(task);
    this.tail = result.catch(() => undefined);
    return result.finally(() => {
      this.pendingCount -= 1;
    });
  }
}
