import { forwardRef, Module } from '@nestjs/common';
import { WhatsappModule } from './whatsapp.module';
import { AccountChannelsModule } from './accountChannels.module';
import { CargoDetectionModule } from './cargoDetection.module';

@Module({
  imports: [
    forwardRef(() => WhatsappModule),
    AccountChannelsModule,
    CargoDetectionModule,
  ],

  providers: [],
  exports: [],

  controllers: [],
})
export class AgentModule { }