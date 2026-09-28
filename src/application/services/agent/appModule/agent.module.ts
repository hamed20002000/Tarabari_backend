import { forwardRef, Module } from '@nestjs/common';
import { TelegramService } from '../services/Telegram.service';
import { WhatsappModule } from './whatsapp.module';
import { TelegramChannelModule } from './telegramChannel.module';
import { CargoDetectionModule } from './cargoDetection.module';

@Module({
  imports: [
    forwardRef(() => WhatsappModule),
    TelegramChannelModule,
    CargoDetectionModule,
  ],

  providers: [TelegramService],
  exports: [TelegramService],

  controllers: [],
})
export class AgentModule { }