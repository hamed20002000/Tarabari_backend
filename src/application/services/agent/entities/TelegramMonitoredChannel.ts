import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';
import { ChannelMembershipStatus, MonitoredChannelRole, MonitoredChatType } from '../types';

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

  // کاربرهایی که این گروه/کانال رو ثبت کردن. پیام‌ها همیشه پردازش می‌شن،
  // ولی اعلان و نمایش پیام‌های بارِ این گروه/کانال فقط برای همین کاربرهاست
  // (ownerUserIds در payload رویداد). ایندکس GIN در مایگریشن ساخته شده.
  @Column('text', { array: true, default: () => "'{}'" })
  ownerUserIds: string[];

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

  @Column({ type: 'timestamptz', nullable: true })
  nextAttemptAt: Date | null;

  // زمان آخرین تلاش عضویت -- برای اعمال سقف روزانه‌ی عضویت (ضد بن).
  @Column({ type: 'timestamptz', nullable: true })
  lastJoinAttemptAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  joinedAt: Date | null;

  // وضعیت عضویت از دید کاربر -- هر تغییرش از طریق ChannelMembershipService
  // (رویداد channel.membership.changed) به ثبت‌کننده‌ها اعلام می‌شه.
  @Column({ type: 'varchar', length: 20, default: ChannelMembershipStatus.QUEUED })
  membershipStatus: ChannelMembershipStatus;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
