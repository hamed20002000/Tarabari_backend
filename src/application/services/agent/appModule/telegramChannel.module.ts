import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TelegramMonitoredChannel } from '../entities/TelegramMonitoredChannel';
import { TelegramChannelMessage } from '../entities/TelegramChannelMessage';
import { OutboxEvent } from '../entities/OutboxEvent';
import { TelegramUserSession } from '../entities/TelegramUserSession';
import { TelegramChannelService } from '../services/telegramChannel.service';
import { CargoDetectionModule } from './cargoDetection.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      TelegramMonitoredChannel,
      TelegramChannelMessage,
      TelegramUserSession,
      OutboxEvent,
    ]),
    CargoDetectionModule,
  ],
  providers: [TelegramChannelService],
  exports: [TelegramChannelService],
})
export class TelegramChannelModule {}
