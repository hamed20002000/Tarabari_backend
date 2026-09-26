import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OutboxEvent } from '../entities/OutboxEvent';
import { OutboxService } from '../services/OutboxService';
import { AppRabbitMQModule } from './RabitMq.module';

// Global -- یک بار در AppModule import می‌شه و OutboxService در همه‌ی ماژول‌ها
// (واتساپ، تلگرام و ...) بدون import دوباره قابل inject هست.
@Global()
@Module({
  imports: [TypeOrmModule.forFeature([OutboxEvent]), AppRabbitMQModule],
  providers: [OutboxService],
  exports: [OutboxService],
})
export class OutboxModule {}
