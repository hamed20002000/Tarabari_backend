import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TelegramMonitoredChannel } from '../entities/TelegramMonitoredChannel';
import { TelegramChannelMessage } from '../entities/TelegramChannelMessage';
import { BaleMonitoredChannel } from '../entities/BaleMonitoredChannel';
import { BaleChannelMessage } from '../entities/BaleChannelMessage';
import { RubikaMonitoredChannel } from '../entities/RubikaMonitoredChannel';
import { RubikaChannelMessage } from '../entities/RubikaChannelMessage';
import { MessengerSession } from '../entities/MessengerSession';
import { OutboxEvent } from '../entities/OutboxEvent';
import { TelegramChannelService } from '../services/telegramChannel.service';
import { BaleChannelService } from '../services/baleChannel.service';
import { RubikaChannelService } from '../services/rubikaChannel.service';
import { CargoDetectionModule } from './cargoDetection.module';

// گوش دادن به گروه/کانال‌ها با اکانت کاربری (تلگرام، بله، روبیکا) -- همه روی AccountChannelMonitor.
@Module({
  imports: [
    TypeOrmModule.forFeature([
      TelegramMonitoredChannel,
      TelegramChannelMessage,
      BaleMonitoredChannel,
      BaleChannelMessage,
      RubikaMonitoredChannel,
      RubikaChannelMessage,
      MessengerSession,
      OutboxEvent,
    ]),
    CargoDetectionModule,
  ],
  providers: [TelegramChannelService, BaleChannelService, RubikaChannelService],
  exports: [TelegramChannelService, BaleChannelService, RubikaChannelService],
})
export class AccountChannelsModule {}
