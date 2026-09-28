// baseinfo.module.ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MonitoredChannel } from 'src/application/services/agent/entities/MonitoredChannel';
import { WhatsappChannelMessage } from '../entities/WhatsappChannelMessage';
import { CargoSubscription } from '../entities/CargoSubscription';
import { CargoSubscriptionController } from 'src/presentation/controllers/admin/cargoSubscription.controller';
import { TelegramMonitoredChannel } from '../entities/TelegramMonitoredChannel';
import { TelegramChannelMessage } from '../entities/TelegramChannelMessage';
import { ChannelsController } from 'src/presentation/controllers/admin/channels.controller';
import { ChannelRegistryService } from '../services/channelRegistry.service';
import { MyChannelsController } from 'src/presentation/controllers/user/myChannels.controller';

@Module({
  imports: [TypeOrmModule.forFeature([MonitoredChannel,WhatsappChannelMessage,CargoSubscription,TelegramMonitoredChannel,TelegramChannelMessage])],
  controllers: [ChannelsController, CargoSubscriptionController, MyChannelsController],
  providers: [ChannelRegistryService],
})
export class BaseinfoModule {}
