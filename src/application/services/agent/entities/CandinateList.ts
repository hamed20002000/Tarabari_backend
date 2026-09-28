import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Generated,
  Index,
} from 'typeorm';

export enum CandidateStatus {
  PENDING = 'pending',   // هنوز هیچ شرکتی انتخابش نکرده
  SELECTED = 'selected', // یه شرکت گرفتتش
  EXPIRED = 'expired',   // اختیاری: اگه بعد از مدتی کسی انتخاب نکرد
}

@Entity()
export class CandidateListing {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  // ارجاع به پیام خامی که این کاندید ازش استخراج شده -- برای ردیابی و
  // دیباگ (که مشخص بشه این کاندید از کدوم پیام واقعی اومده).
  @Index()
  @Column()
  rawMessageId: string;

  // کد پیگیری قابل‌گفتن تلفنی -- مستقل از orderNumber پیام خام، چون این
  // موجودیتیه که مشتری/شرکت باهاش سروکار داره، نه پیام خام واتساپ.
  @Index({ unique: true })
  @Column()
  @Generated('increment')
  orderNumber: number;

  @Column({ nullable: true })
  origin: string | null;

  @Column({ nullable: true })
  destination: string | null;

  @Column({ nullable: true })
  cargoType: string | null;

  @Column({ nullable: true })
  weight: string | null;

  @Column({ nullable: true })
  vehicleType: string | null;

  @Column({ nullable: true })
  price: string | null;

  @Column('text', { nullable: true })
  extraNotes: string | null;

  @Index()
  @Column({ type: 'enum', enum: CandidateStatus, default: CandidateStatus.PENDING })
  status: CandidateStatus;

  // بعد از انتخاب توسط یه شرکت پر می‌شن -- قبلش null هستن.
  @Column({ nullable: true })
  selectedByCompanyId: string | null;

  @Column({ nullable: true })
  selectedByCompanyName: string | null;

  @Column({ nullable: true })
  selectedByCompanyPhone: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  selectedAt: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}