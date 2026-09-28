import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

@Entity()
export class WhatsappChannelMessage {
  @PrimaryGeneratedColumn('uuid')
  id: string;

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

  @Column('simple-json', { nullable: true })
  foundPhoneNumbers: string[] | null;

  @CreateDateColumn({ type: 'timestamptz' })
  receivedAt: Date;
}