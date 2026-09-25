import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

@Entity()
export class OutboxEvent {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  // مثلاً 'candidate.created' -- همون routing key که در RabbitMQ استفاده می‌شه
  @Column()
  eventType: string;

  // داده‌ی واقعی event -- هر ساختاری که برای اون رویداد نیاز باشه
  @Column('jsonb')
  payload: Record<string, unknown>;

  // false تا وقتی که واقعاً با موفقیت به RabbitMQ publish بشه
  @Index()
  @Column({ default: false })
  published: boolean;

  @CreateDateColumn()
  createdAt: Date;
}