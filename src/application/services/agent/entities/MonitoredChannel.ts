import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
} from 'typeorm';
import { MonitoredChannelRole, MonitoredChatType } from '../types';



@Entity()
export class MonitoredChannel {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  // برای کانال: کد دعوت بعد از channel/ در لینک (یا JID کامل xxxx@newsletter)
  // برای گروه: کد دعوت بعد از chat.whatsapp.com/ در لینک (یا JID کامل xxxx@g.us)
  @Column({ unique: true })
  identifier: string;

  // مشخص می‌کنه این رکورد گروهه یا کانال -- چون فرمت لینک و API فالو/جوین
  // کردنشون در Baileys کاملاً متفاوته (newsletterFollow در برابر
  // groupAcceptInvite)، باید صراحتاً مشخص بشه، نه از روی حدس.
  @Column({ type: 'enum', enum: MonitoredChatType, default: MonitoredChatType.GROUP })
  type: MonitoredChatType;

  // NEW: مشخص می‌کنه این رکورد به‌عنوان منبع خوندن پیام استفاده می‌شه،
  // مقصد فرستادن پیام‌های پردازش‌شده‌ست، یا هر دو. پیش‌فرض SOURCE چون
  // اکثر رکوردهای قبلی (گروه‌های بار) این نقش رو داشتن.
  @Column({ type: 'enum', enum: MonitoredChannelRole, default: MonitoredChannelRole.SOURCE })
  role: MonitoredChannelRole;

  // بعد از فالو/جوین شدن موفق، JID واقعی اینجا ذخیره می‌شه
  // (xxxx@newsletter برای کانال، xxxx@g.us برای گروه).
  @Column({ nullable: true })
  resolvedJid: string | null;

  // اسم دلخواه برای نمایش در پنل مدیر (مثلاً "گروه بار تهران-مشهد").
  @Column({ nullable: true })
  label: string | null;

  // مدیر می‌تونه بدون حذف کامل رکورد، موقتاً غیرفعالش کنه.
  @Column({ default: true })
  isActive: boolean;

  // وضعیت فالو/جوین شدن -- برای اینکه polling بدونه کدوم‌ها هنوز پردازش
  // نشدن و دوباره روی موارد قبلاً موفق کار نکنه.
  @Column({ default: false })
  isFollowed: boolean;

  // اگه فالو/جوین کردن fail بشه، آخرین پیام خطا اینجا ذخیره می‌شه
  // (برای دیباگ/نمایش در پنل مدیر).
  @Column('text', { nullable: true })
  lastError: string | null;

  // NEW: تعداد تلاش‌های ناموفق پشت‌سرهم -- برای محاسبه‌ی فاصله‌ی
  // exponential backoff استفاده می‌شه. با هر موفقیت به صفر ریست می‌شه.
  @Column({ default: 0 })
  retryCount: number;

  // NEW: زمانی که اولین بار مجدداً باید این رکورد امتحان بشه. تا این زمان
  // نرسیده، polling این رکورد رو کلاً نادیده می‌گیره -- حتی اگه isFollowed
  // هنوز false باشه. با هر موفقیت null می‌شه.
  @Column({ type: 'timestamp', nullable: true })
  nextAttemptAt: Date | null;

  @CreateDateColumn()
  createdAt: Date;
}