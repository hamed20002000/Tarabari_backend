import { Column, Entity, Index } from 'typeorm';
import { AccountMonitoredChannelBase } from './AccountChannelBase';

/**
 * گروه/کانال‌های بله که اکانت کاربری برنامه (balejs) با لینک عضوشون می‌شه و
 * بهشون گوش می‌ده -- ساختارش مثل TelegramMonitoredChannel هست.
 */
@Entity()
export class BaleMonitoredChannel extends AccountMonitoredChannelBase {
  // لینک گروه/کانال: خصوصی (ble.ir/join/TOKEN) یا عمومی (ble.ir/username).
  @Index('UQ_bale_monitored_channel_identifier', { unique: true })
  @Column({ type: 'varchar', nullable: true })
  identifier: string | null;

  // شناسه‌ی عددی گروه/کانال در بله -- بعد از عضویت موفق پر می‌شه.
  @Index('UQ_bale_monitored_channel_chatId', { unique: true })
  @Column({ type: 'varchar', nullable: true })
  chatId: string | null;
}
