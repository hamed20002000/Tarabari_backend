import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/**
 * نشست (StringSession) اکانت کاربری تلگرام که برنامه باهاش به گروه/کانال‌ها
 * گوش می‌ده -- معادل WhatsappAuthCredential. یک بار با اسکریپت
 * `npm run telegram:login` ساخته می‌شه و بعد از اون سرویس ازش استفاده می‌کنه.
 */
@Entity()
export class TelegramUserSession {
  @PrimaryColumn({ type: 'varchar', length: 100 })
  sessionId: string;

  @Column('text')
  session: string;

  @UpdateDateColumn()
  updatedAt: Date;
}
