import { forwardRef, Module } from '@nestjs/common';
import { TelegramService } from '../services/Telegram.service';
import { WhatsappModule } from './whatsapp.module';
import { AccountChannelsModule } from './accountChannels.module';
import { CargoDetectionModule } from './cargoDetection.module';

@Module({
  imports: [
    forwardRef(() => WhatsappModule),
    AccountChannelsModule,
    CargoDetectionModule,
  ],

  providers: [TelegramService],
  exports: [TelegramService],

  controllers: [],
})
export class AgentModule { }