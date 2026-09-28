import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/**
 * آبجکت AuthenticationCreds مربوط به Baileys رو (به‌صورت رشته‌ی JSON) نگه می‌داره.
 * sessionId می‌تونه یک مقدار ثابت باشه (مثلاً 'main') یا اگه پشتیبانی از
 * چند شماره بخواید، برای هر شماره‌ی واتساپ یک id جدا باشه.
 */
@Entity('WhatsappAuthCredential')
export class WhatsappAuthCredential {
  @PrimaryColumn({ type: 'varchar', length: 100 })
  sessionId: string;

  @Column({ type: 'text' })
  credsJson: string;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}