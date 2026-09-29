import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

/**
 * پیام‌های بارِ تشخیص‌داده‌شده از گروه/کانال‌های تلگرام. فقط پیام‌هایی که
 * بار هستن ذخیره می‌شن.
 */
@Entity()
// message_id تلگرام فقط داخل یک چت یکتاست، برای همین یکتایی روی جفت (chatId, messageId) هست.
@Index('UQ_telegram_channel_message_chat_message', ['chatId', 'messageId'], { unique: true })
export class TelegramChannelMessage {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** کد پیگیری بار (مثل TRB100000) -- از sequence مشترک cargo_code_seq، بین واتساپ و تلگرام یکتاست. */
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 20 })
  code: string;

  @Index('IDX_telegram_channel_message_chatId')
  @Column({ type: 'bigint' })
  chatId: string;

  @Column({ type: 'integer' })
  messageId: number;

  @Column('text')
  rawText: string;

  @Column({ type: 'float', nullable: true })
  confidence: number | null;

  @Column('simple-json', { nullable: true })
  foundPhoneNumbers: string[] | null;

  @CreateDateColumn({ type: 'timestamptz' })
  receivedAt: Date;
}
