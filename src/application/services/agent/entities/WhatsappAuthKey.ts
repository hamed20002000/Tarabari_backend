import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/**
 * signal key store مربوط به Baileys (pre-key, session, sender-key,
 * app-state-sync-key, app-state-sync-version...) رو به‌صورت key-value نگه می‌داره.
 * useMultiFileAuthState برای هر key یک فایل جدا می‌نوشت؛
 * اینجا همون منطق با ردیف‌های دیتابیس پیاده شده.
 */
@Entity('WhatsappAuthKey')
export class WhatsappAuthKey {
  @PrimaryColumn({ type: 'varchar', length: 100 })
  sessionId: string;

  @PrimaryColumn({ type: 'varchar', length: 100 })
  keyType: string;

  @PrimaryColumn({ type: 'varchar', length: 200 })
  keyId: string;

  @Column({ type: 'text' })
  valueJson: string;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}