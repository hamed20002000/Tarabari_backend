import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/**
 * نشست اکانت کاربری‌ای که برنامه باهاش به گروه/کانال‌ها گوش می‌ده -- یک
 * رکورد برای هر پلتفرم (sessionId همون اسم پلتفرمه: telegram، bale، rubika).
 * یک بار با اسکریپت `npm run <platform>:login` ساخته می‌شه و بعد از اون
 * سرویس همون پلتفرم ازش استفاده می‌کنه.
 */
@Entity()
export class MessengerSession {
  @PrimaryColumn({ type: 'varchar', length: 100 })
  sessionId: string;

  @Column('text')
  session: string;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
