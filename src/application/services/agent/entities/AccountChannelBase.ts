import { Column, CreateDateColumn, Index, PrimaryGeneratedColumn } from 'typeorm';
import { ChannelMembershipStatus, MonitoredChannelRole, MonitoredChatType } from '../types';

/**
 * ستون‌های مشترک گروه/کانال‌هایی که اکانت کاربری برنامه با لینک عضوشون می‌شه
 * (تلگرام، بله، روبیکا). هر پلتفرم جدول خودش رو داره و فقط identifier و
 * chatId (که نوع و ایندکس‌شون فرق می‌کنه) رو خودش تعریف می‌کنه.
 */
export abstract class AccountMonitoredChannelBase {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** شکل یکتای لینک گروه/کانال (خروجی normalizeIdentifier همون پلتفرم). */
  identifier: string | null;

  /** شناسه‌ی چت در پلتفرم -- بعد از عضویت موفق پر می‌شه. */
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

/**
 * ستون‌های مشترک پیام‌های بارِ تشخیص‌داده‌شده از گروه/کانال‌های تلگرام، بله و
 * روبیکا. فقط پیام‌هایی که بار هستن ذخیره می‌شن. chatId و messageId رو هر
 * پلتفرم با نوع خودش تعریف می‌کنه (یکتایی روی جفت این دو هست).
 */
export abstract class AccountChannelMessageBase {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** کد پیگیری بار (مثل TRB100000) -- از sequence مشترک cargo_code_seq، بین همه‌ی پلتفرم‌ها یکتاست. */
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 20 })
  code: string;

  chatId: string;

  messageId: string | number;

  @Column('text')
  rawText: string;

  @Column({ type: 'float', nullable: true })
  confidence: number | null;

  @Column('simple-json', { nullable: true })
  foundPhoneNumbers: string[] | null;

  @CreateDateColumn({ type: 'timestamptz' })
  receivedAt: Date;
}
