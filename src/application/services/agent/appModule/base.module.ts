// baseinfo.module.ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BaseinfoController } from 'src/presentation/controllers/admin/baseinfo.controller';
import { MonitoredChannel } from 'src/application/services/agent/entities/MonitoredChannel';
import { WhatsappMessageController } from 'src/presentation/controllers/admin/whatsappmessage.controller';
import { WhatsappChannelMessage } from '../entities/WhatsappChannelMessage';
import { CargoSubscription } from '../entities/CargoSubscription';
import { CargoSubscriptionController } from 'src/presentation/controllers/admin/cargoSubscription.controller';

@Module({
  imports: [TypeOrmModule.forFeature([MonitoredChannel,WhatsappChannelMessage,CargoSubscription])],
  controllers: [BaseinfoController,WhatsappMessageController,CargoSubscriptionController],
})
export class BaseinfoModule {}