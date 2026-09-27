import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WhatsappService } from '../services/whatsapp.service';
import { WhatsappAuthCredential } from '../entities/WhatsappAuthCredential';
import { WhatsappAuthKey } from '../entities/WhatsappAuthKey';
import { WhatsappUserMapping } from '../entities/WhatsappUserMapping';
// این importو با ماژولی که AgentGateway/FunctionCallService رو export می‌کنه جایگزین کنید
import { AgentModule } from './agent.module';
import { AuthModule } from 'src/auth/auth.module';
import { WhatsappChannelMessage } from '../entities/WhatsappChannelMessage';
import { MonitoredChannel } from '../entities/MonitoredChannel';
import { CargoDetectionModule } from './cargoDetection.module';
import { CargoSubscription } from '../entities/CargoSubscription';
import { CargoSubscriptionService } from '../services/cargoSubscription.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      WhatsappAuthCredential,
      WhatsappAuthKey,
      WhatsappUserMapping,
      WhatsappChannelMessage,
      MonitoredChannel,
      CargoSubscription,
    ]),
    // forwardRef چون AgentGateway هم برعکس به WhatsappService نیاز داره
    forwardRef(() => AgentModule),
    AuthModule,
    CargoDetectionModule,
  ],
  providers: [WhatsappService,CargoSubscriptionService],
  exports: [WhatsappService],
})
export class WhatsappModule {}