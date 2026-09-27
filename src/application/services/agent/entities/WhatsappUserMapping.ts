import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * نگاشت بین userid + username (دو فیلد جدا در سیستم) و jid واتساپ (شماره).
 */
@Entity('WhatsappUserMapping')
export class WhatsappUserMapping {
  @PrimaryColumn({ type: 'varchar', length: 100 })
  userid: string;

  @Column({ type: 'varchar', length: 100 })
  username: string;

  @Column({ type: 'varchar', length: 100,unique:true })
  jid: string;
}