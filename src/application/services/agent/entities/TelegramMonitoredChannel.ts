import { Column, Entity, Index } from 'typeorm';
import { AccountMonitoredChannelBase } from './AccountChannelBase';

/**
 * گروه/کانال‌های تلگرامی که اکانت کاربری برنامه (GramJS) بهشون گوش می‌ده --
 * معادل تلگرامیِ MonitoredChannel واتساپ. کافیه لینک ثبت بشه؛ برنامه خودش
 * عضو می‌شه (یا اگه گروه تایید ادمین لازم داره، درخواست عضویت می‌فرسته).
 */
@Entity()
export class TelegramMonitoredChannel extends AccountMonitoredChannelBase {
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
}
