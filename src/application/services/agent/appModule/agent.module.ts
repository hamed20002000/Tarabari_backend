import { forwardRef, Module } from '@nestjs/common';
import { TelegramService } from '../services/Telegram.service';
import { UserService } from '../../user/user.service';
import { UserModule } from '../../user/appModuls/user.module';
import { AuthService } from 'src/auth/auth.service';
import { AuthModule } from 'src/auth/auth.module';
import { WhatsappService } from '../services/whatsapp.service';
import { JwtService } from '@nestjs/jwt';
import { WhatsappModule } from './whatsapp.module';

@Module({
  imports: [
    forwardRef(() => UserModule),
    forwardRef(() => AuthModule),
    forwardRef(() => WhatsappModule),
  ],

  providers: [
    TelegramService,
    UserService,
    JwtService

  ],
  exports: [
    TelegramService,
    UserService,
    JwtService

  ],

  controllers: [],
})
export class AgentModule { }