import { Column, Entity, Index } from 'typeorm';
import { AccountChannelMessageBase } from './AccountChannelBase';

/**
 * پیام‌های بارِ تشخیص‌داده‌شده از گروه/کانال‌های تلگرام. فقط پیام‌هایی که
 * بار هستن ذخیره می‌شن.
 */
@Entity()
// message_id تلگرام فقط داخل یک چت یکتاست، برای همین یکتایی روی جفت (chatId, messageId) هست.
@Index('UQ_telegram_channel_message_chat_message', ['chatId', 'messageId'], { unique: true })
export class TelegramChannelMessage extends AccountChannelMessageBase {
  @Index('IDX_telegram_channel_message_chatId')
  @Column({ type: 'bigint' })
  chatId: string;

  @Column({ type: 'integer' })
  messageId: number;
}
