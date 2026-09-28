import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

/**
 * تنظیمات اطلاع‌رسانی یه subscriber (کاربر/شرکت) برای پیام‌های بار.
 * هر subscriber می‌تونه چند ردیف داشته باشه (مثلاً یکی برای تهران به مشهد و
 * یکی برای هر باری از اصفهان) -- کافیه یکی از ردیف‌هاش match بشه.
 *
 * هر فیلتر یه لیسته: خالی یعنی «همه»، وگرنه مقدار استخراج‌شده از پیام باید
 * حداقل یکی از آیتم‌ها رو شامل بشه. ردیفی که همه‌ی فیلترهاش خالیه، همه‌ی
 * پیام‌های بار رو دریافت می‌کنه.
 */
@Entity()
export class CargoSubscription {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  // شناسه‌ی کاربر/شرکت در سیستم اصلی -- consumerهای RabbitMQ با همین
  // شناسه تشخیص می‌دن event مال کیه.
  @Index('IDX_cargo_subscription_subscriberId')
  @Column()
  subscriberId: string;

  // اسم دلخواه برای نمایش در پنل مدیر
  @Column({ type: 'varchar', nullable: true })
  label: string | null;

  @Column('text', { array: true, default: () => "'{}'" })
  origins: string[];

  @Column('text', { array: true, default: () => "'{}'" })
  destinations: string[];

  @Column('text', { array: true, default: () => "'{}'" })
  cargoTypes: string[];

  @Column('text', { array: true, default: () => "'{}'" })
  vehicleTypes: string[];

  @Index('IDX_cargo_subscription_isActive')
  @Column({ default: true })
  isActive: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
