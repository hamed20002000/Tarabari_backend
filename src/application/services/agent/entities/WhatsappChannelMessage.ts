import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

@Entity()
// یک پیام ممکنه چند بار داشته باشه -- هر بار یک رکورد با cargoIndex خودش.
@Index('UQ_whatsapp_channel_message_message_cargo', ['messageId', 'cargoIndex'], { unique: true })
export class WhatsappChannelMessage {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** کد پیگیری بار (مثل TRB100000) -- از sequence مشترک cargo_code_seq، بین واتساپ و تلگرام یکتاست. */
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 20 })
  code: string;

  @Index()
  @Column()
  channelJid: string;

  @Column()
  messageId: string;

  /** ترتیب بار داخل پیام (۰ برای اولین). */
  @Column({ type: 'integer', default: 0 })
  cargoIndex: number;

  @Column('text')
  rawText: string;

  @Column({ type: 'boolean', nullable: true })
  isCargoOrder: boolean | null;

  @Column({ type: 'float', nullable: true })
  confidence: number | null;

  @Column('simple-json', { nullable: true })
  foundPhoneNumbers: string[] | null;

  @CreateDateColumn({ type: 'timestamptz' })
  receivedAt: Date;
}