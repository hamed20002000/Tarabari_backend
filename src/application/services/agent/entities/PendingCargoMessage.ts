import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * پیامی که وقتی مدل در دسترس نبود (OpenAI یا VPN قطع، LlmUnavailableError) پردازش نشد -- به‌جای اینکه از دست
 * بره، اینجا می‌مونه و CargoPipelineService دوباره امتحانش می‌کنه تا CARGO_RETRY_MAX_HOURS.
 * همه‌ی چیزی که برای پردازش دوباره لازمه (CargoCandidate) نگه داشته می‌شه، entity با اسمش.
 */
@Entity()
export class PendingCargoMessage {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  label: string;

  /** تا وقتی پیام صوتی هنوز به متن تبدیل نشده (audio)، خالیه */
  @Column('text')
  text: string;

  /** صدای پیامی که مدل هنوز نتونسته به متن تبدیلش کنه؛ بعد از تبدیل پاک می‌شه */
  @Column({ type: 'bytea', nullable: true })
  audio: Buffer | null;

  @Column({ default: false })
  isVoice: boolean;

  /** اسم entity پیام‌های همون پلتفرم (WhatsappChannelMessage و ...) */
  @Column()
  entityName: string;

  @Column('jsonb')
  record: Record<string, unknown>;

  @Column('jsonb')
  source: Record<string, unknown>;

  @Column('jsonb')
  ownerUserIds: string[];

  @Column({ default: 0 })
  attempts: number;

  @Index()
  @Column({ type: 'timestamptz' })
  nextAttemptAt: Date;

  @Column({ type: 'text', nullable: true })
  lastError: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
