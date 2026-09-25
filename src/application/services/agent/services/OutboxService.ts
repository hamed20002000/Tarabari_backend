import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Cron } from '@nestjs/schedule';
import { AmqpConnection } from '@golevelup/nestjs-rabbitmq';
import { OutboxEvent } from '../entities/OutboxEvent';

@Injectable()
export class OutboxService {
  private readonly logger = new Logger(OutboxService.name);

  constructor(
    @InjectRepository(OutboxEvent)
    private readonly outboxRepo: Repository<OutboxEvent>,
    private readonly amqpConnection: AmqpConnection,
  ) {}

  /**
   * هر ۱۰ ثانیه رکوردهای منتشرنشده‌ی outbox رو می‌خونه و به RabbitMQ
   * publish می‌کنه. اگه publish یه رکورد fail بشه، published همچنان
   * false می‌مونه و دور بعدی دوباره تلاش می‌شه -- هیچ eventی گم نمی‌شه.
   */
  @Cron('*/10 * * * * *')
  async publishPendingEvents(): Promise<void> {
    const pending = await this.outboxRepo.find({
      where: { published: false },
      order: { createdAt: 'ASC' },
      take: 50,
    });

    if (pending.length === 0) return;

    for (const event of pending) {
      try {
        await this.amqpConnection.publish(
          'cargo_events', // اسم exchange
          event.eventType, // routing key
          event.payload,
        );

        event.published = true;
        await this.outboxRepo.save(event);

        this.logger.log(`📤 Event yayınlandı: ${event.eventType} [${event.id}]`);
      } catch (error) {
        this.logger.error(
          `Event yayınlanamadı, tekrar denenecek: ${event.id}`,
          error as Error,
        );
      }
    }
  }
}