import { Column, Entity, Index } from 'typeorm';
import { AccountChannelMessageBase } from './AccountChannelBase';

/** پیام‌های بارِ تشخیص‌داده‌شده از گروه/کانال‌های بله. */
@Entity()
@Index('UQ_bale_channel_message_chat_message', ['chatId', 'messageId'], { unique: true })
export class BaleChannelMessage extends AccountChannelMessageBase {
  @Index('IDX_bale_channel_message_chatId')
  @Column({ type: 'varchar' })
  chatId: string;

  // rid بله (int64) -- به‌صورت متن ذخیره می‌شه.
  @Column({ type: 'varchar' })
  messageId: string;
}
