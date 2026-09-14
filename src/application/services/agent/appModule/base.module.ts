// baseinfo.module.ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BaseinfoController } from 'src/presentation/controllers/admin/baseinfo.controller';
import { MonitoredChannel } from 'src/application/services/agent/entities/MonitoredChannel';
import { WhatsappMessageController } from 'src/presentation/controllers/admin/whatsappmessage.controller';
import { WhatsappChannelMessage } from '../entities/WhatsappChannelMessage';

@Module({
  imports: [TypeOrmModule.forFeature([MonitoredChannel,WhatsappChannelMessage])],
  controllers: [BaseinfoController,WhatsappMessageController],
})
export class BaseinfoModule {}