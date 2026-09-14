// src/auth/auth.module.ts
import { forwardRef, Module } from '@nestjs/common';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { JwtStrategy } from './strategy/jwt.strategy';
import { PassportModule } from '@nestjs/passport';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { UserModule } from 'src/application/services/user/appModuls/user.module';
import { GoogleStrategy } from './strategy/google.strategy';
import { UserService } from 'src/application/services/user/user.service';
import { HttpModule, HttpService } from '@nestjs/axios';
import { PasswordService } from 'src/application/services/agent/services/password.service';



@Module({
  imports: [
    HttpModule,
    forwardRef(() => UserModule),
    // Register ConfigModule to read environment variables
    ConfigModule.forRoot({
      isGlobal: true,  // Makes the config available globally in the app
    }),

    PassportModule.register({ defaultStrategy: 'jwt' }),

    JwtModule.registerAsync({
      imports: [ConfigModule],  // Import ConfigModule to access environment variables
      useFactory: async (configService: ConfigService) => ({
        secret: configService.get<string>('JWT_SECRET_KEY','ad;,pwqdpoqwkdopkwqopdqwpdkqwd65165dw1q5d1wqd;wq,dqwdASDwqd'),  // Retrieve the secret from environment variables
        signOptions: { expiresIn: configService.get<number>('JWT_EXPIRATION_TIME',64800) },  // Retrieve expiration time from environment variables
      }),
      inject: [ConfigService],  // Inject ConfigService
    }),

    forwardRef(() => UserModule),
    
  ],
  providers: [AuthService, JwtStrategy,GoogleStrategy,UserService,PasswordService],  // No need to manually inject UserRepository anymore
  controllers: [AuthController],
  exports: [AuthService],
})
export class AuthModule {}
