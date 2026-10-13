import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * اثر انگشت متن پیام‌های پردازش‌شده، به ازای هر ثبت‌کننده -- همون آگهی که
 * دوباره در کانال پست می‌شه (یا در چند گروه/پلتفرم پخش می‌شه) شناسه‌ی پیام
 * جدید داره ولی متنش یکیه؛ تا CARGO_DUPLICATE_WINDOW_HOURS دوباره به مدل
 * فرستاده نمی‌شه و برای کاربری که قبلاً گرفته دوباره اعلان نمی‌شه.
 */
@Entity()
export class CargoTextFingerprint {
  /** sha256 متن یکسان‌شده (cargoTextHash). */
  @PrimaryColumn({ type: 'varchar', length: 64 })
  contentHash: string;

  @PrimaryColumn({ type: 'varchar' })
  userId: string;

  @Column({ type: 'timestamptz' })
  seenAt: Date;
}
