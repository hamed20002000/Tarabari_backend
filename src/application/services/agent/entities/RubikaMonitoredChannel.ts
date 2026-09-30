import { Column, Entity, Index } from 'typeorm';
import { AccountMonitoredChannelBase } from './AccountChannelBase';

/**
 * گروه/کانال‌های روبیکا که اکانت کاربری برنامه (rubjs) با لینک عضوشون می‌شه
 * و بهشون گوش می‌ده -- ساختارش مثل TelegramMonitoredChannel هست.
 */
@Entity()
export class RubikaMonitoredChannel extends AccountMonitoredChannelBase {
  // لینک گروه/کانال: خصوصی (rubika.ir/joing/HASH یا rubika.ir/joinc/HASH) یا عمومی (rubika.ir/username).
  @Index('UQ_rubika_monitored_channel_identifier', { unique: true })
  @Column({ type: 'varchar', nullable: true })
  identifier: string | null;

  // guid گروه/کانال در روبیکا (g0... یا c0...) -- بعد از عضویت موفق پر می‌شه.
  @Index('UQ_rubika_monitored_channel_chatId', { unique: true })
  @Column({ type: 'varchar', nullable: true })
  chatId: string | null;
}
