import { Column, Entity, Index } from 'typeorm';
import { AccountChannelMessageBase } from './AccountChannelBase';

/** پیام‌های بارِ تشخیص‌داده‌شده از گروه/کانال‌های روبیکا. */
@Entity()
@Index('UQ_rubika_channel_message_chat_message', ['chatId', 'messageId'], { unique: true })
export class RubikaChannelMessage extends AccountChannelMessageBase {
  @Index('IDX_rubika_channel_message_chatId')
  @Column({ type: 'varchar' })
  chatId: string;

  // message_id روبیکا -- به‌صورت متن ذخیره می‌شه.
  @Column({ type: 'varchar' })
  messageId: string;
}
