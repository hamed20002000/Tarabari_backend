import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';
import { MonitoredChannelRole, MonitoredChatType } from '../types';

/**
 * گروه/کانال‌های تلگرامی که اکانت کاربری برنامه (GramJS) بهشون گوش می‌ده --
 * معادل تلگرامیِ MonitoredChannel واتساپ. کافیه لینک ثبت بشه؛ برنامه خودش
 * عضو می‌شه (یا اگه گروه تایید ادمین لازم داره، درخواست عضویت می‌فرسته).
 */
@Entity()
export class TelegramMonitoredChannel {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  // لینک گروه/کانال: عمومی (t.me/username یا @username) یا خصوصی
  // (t.me/+HASH یا t.me/joinchat/HASH).
  @Index('UQ_telegram_monitored_channel_identifier', { unique: true })
  @Column({ type: 'varchar', nullable: true })
  identifier: string | null;

  // شناسه‌ی عددی چت در تلگرام (برای سوپرگروه/کانال به شکل -100xxxxxxxxxx).
  // بعد از عضویت موفق پر می‌شه. TypeORM مقدار bigint رو string برمی‌گردونه.
  @Index('UQ_telegram_monitored_channel_chatId', { unique: true })
  @Column({ type: 'bigint', nullable: true })
  chatId: string | null;

  @Column({ type: 'enum', enum: MonitoredChatType, default: MonitoredChatType.GROUP })
  type: MonitoredChatType;

  @Column({ type: 'enum', enum: MonitoredChannelRole, default: MonitoredChannelRole.SOURCE })
  role: MonitoredChannelRole;

  // اسم نمایشی -- اگه خالی باشه، موقع عضویت از عنوان چت پر می‌شه.
  @Column({ type: 'varchar', nullable: true })
  label: string | null;

  @Column({ default: true })
  isActive: boolean;

  // آیا اکانت برنامه الان عضو این گروه/کانال هست یا نه.
  @Column({ default: false })
  isMember: boolean;

  // درخواست عضویت فرستاده شده و منتظر تایید ادمین گروه/کاناله.
  @Column({ default: false })
  joinRequestPending: boolean;

  @Column('text', { nullable: true })
  lastError: string | null;

  @Column({ default: 0 })
  retryCount: number;

  @Column({ type: 'timestamp', nullable: true })
  nextAttemptAt: Date | null;

  // زمان آخرین تلاش عضویت -- برای اعمال سقف روزانه‌ی عضویت (ضد بن).
  @Column({ type: 'timestamp', nullable: true })
  lastJoinAttemptAt: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  joinedAt: Date | null;

  @CreateDateColumn()
  createdAt: Date;
}
