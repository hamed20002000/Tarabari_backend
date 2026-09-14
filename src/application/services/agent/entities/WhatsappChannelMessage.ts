import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Generated,
  Index,
} from 'typeorm';

@Entity()
export class WhatsappChannelMessage {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  // NEW: شماره‌ی ترتیبی و یکتای هر پیام -- برای اینکه مشتری بتونه فقط این
  // عدد رو تلفنی به صاحب‌کار بگه، و صاحب‌کار/اپراتور بتونه سریع با همین
  // عدد در دیتابیس جستجو کنه (به‌جای UUID طولانی و غیرقابل‌گفتن). چون
  // generated: 'increment' هست، پایگاه‌داده (Postgres) خودش این مقدار رو
  // به‌صورت ترتیبی و یکتا تولید می‌کنه -- نیازی به منطق دستی شمارش نیست.
  @Index({ unique: true })
  @Column()
  @Generated('increment')
  orderNumber: number;

  @Index()
  @Column()
  channelJid: string;

  @Index({ unique: true })
  @Column()
  messageId: string;

  @Column('text')
  rawText: string;

  @Column({ type: 'boolean', nullable: true })
  isCargoOrder: boolean | null;

  @Column({ type: 'float', nullable: true })
  confidence: number | null;

  @Column('text', { nullable: true })
  processedText: string | null;

  @Column('simple-json', { nullable: true })
  foundPhoneNumbers: string[] | null;

  @CreateDateColumn()
  receivedAt: Date;
}