import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { MulterModule } from '@nestjs/platform-express';
import { fileUploadOptions } from './interceptors/file-option';
import { ServeStaticModule } from '@nestjs/serve-static';
import * as path from 'path';
import { TelegramLink } from './application/services/agent/entities/TelegramLink';
import { TelegramLinkCode } from './application/services/agent/entities/TelegramLinkCode';
import { WhatsappModule } from './application/services/agent/appModule/whatsapp.module';
import { WhatsappAuthCredential } from './application/services/agent/entities/WhatsappAuthCredential';
import { WhatsappAuthKey } from './application/services/agent/entities/WhatsappAuthKey';
import { WhatsappUserMapping } from './application/services/agent/entities/WhatsappUserMapping';
// NEW: این دو Entity قبلاً در آرایه‌ی entities لیست نشده بودن -- بدونشون
// TypeORM اصلاً این جدول‌ها رو نمی‌شناسه، حتی برای کوئری زدن.
import { WhatsappChannelMessage } from './application/services/agent/entities/WhatsappChannelMessage';
import { MonitoredChannel } from './application/services/agent/entities/MonitoredChannel';
import { TelegramMonitoredChannel } from './application/services/agent/entities/TelegramMonitoredChannel';
import { TelegramChannelMessage } from './application/services/agent/entities/TelegramChannelMessage';
import { BaleMonitoredChannel } from './application/services/agent/entities/BaleMonitoredChannel';
import { BaleChannelMessage } from './application/services/agent/entities/BaleChannelMessage';
import { RubikaMonitoredChannel } from './application/services/agent/entities/RubikaMonitoredChannel';
import { RubikaChannelMessage } from './application/services/agent/entities/RubikaChannelMessage';
import { MessengerSession } from './application/services/agent/entities/MessengerSession';
import { OutboxEvent } from './application/services/agent/entities/OutboxEvent';
import { CandidateListing } from './application/services/agent/entities/CandinateList';
import { CargoSubscription } from './application/services/agent/entities/CargoSubscription';
// NEW: ماژول کنترلر پنل مدیر برای افزودن/حذف گروه و کانال
import { BaseinfoModule } from './application/services/agent/appModule/base.module';
import { OutboxModule } from './application/services/agent/appModule/outbox.module';
import { ScheduleModule } from '@nestjs/schedule';
import { APP_GUARD } from '@nestjs/core';
import { InternalApiKeyGuard } from './infrastructure/security/internalApiKey.guard';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    ServeStaticModule.forRoot(
      {
        rootPath: path.join(__dirname, '..', 'uploads'),
        serveRoot: '/uploads',
      },
      {
        rootPath: path.join(__dirname, '..', 'cdn'),
        serveRoot: '/cdn',
      },
    ),
    MulterModule.registerAsync({
      useFactory: () => fileUploadOptions,
    }),
    ThrottlerModule.forRoot([
      {
        ttl: 60000,
        limit: 10,
      },
    ]),
    ConfigModule.forRoot({
      isGlobal: true, // Makes the config available globally
      envFilePath: '.env', // Specify the path to the .env file in the dist folder
    }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        type: 'postgres',
        host: configService.get<string>('DB_HOST', 'localhost'),
        port: configService.get<number>('DB_PORT', 5432),
        username: configService.get<string>('DB_USERNAME', 'postgres'),
        password: configService.get<string>('DB_PASSWORD', '123qwe$%'),
        database: configService.get<string>('DB_DATABASE', 'SetasportalDb'),
        entities: [
          TelegramLink,
          TelegramLinkCode,
          WhatsappAuthCredential,
          WhatsappAuthKey,
          WhatsappUserMapping,
          WhatsappChannelMessage, // NEW
          MonitoredChannel, // NEW
          TelegramMonitoredChannel,
          TelegramChannelMessage,
          BaleMonitoredChannel,
          BaleChannelMessage,
          RubikaMonitoredChannel,
          RubikaChannelMessage,
          MessengerSession,
          OutboxEvent,
          CandidateListing,
          CargoSubscription,
        ],
        migrations: ['domain/migrations/*.ts'],
        migrationsRun: false,
        synchronize: false, // Disable auto schema synchronization
        logging: true, // ['error'], // Log only errors
        logger: 'advanced-console',
        // NEW: اگه اتصال دیتابیس در لحظه‌ی استارت یا بعداً قطع بشه، به‌جای
        // اینکه بلافاصله fail کنه (و باعث uncaughtException بشه)، تا ۱۰ بار
        // با فاصله‌ی ۳ ثانیه دوباره تلاش می‌کنه وصل بشه.
        retryAttempts: 10,
        retryDelay: 3000,
        // NEW: هر ۳۰ ثانیه یه پیام keep-alive روی سطح TCP می‌فرسته تا
        // کانکشن‌های بی‌کار به‌خاطر idle timeout فایروال/پراکسی بسته نشن --
        // یکی از دلایل رایج خطای "Connection terminated unexpectedly".
        extra: {
          keepAlive: true,
          keepAliveInitialDelayMillis: 30000,
          // همه‌ی ستون‌های زمانی timestamptz هستن؛ نشست دیتابیس روی UTC تا به
          // TimeZone سرور Postgres یا TZ پروسه‌ی Node وابسته نباشه.
          options: '-c timezone=UTC',
        },
      }),
    }),
    WhatsappModule,
    BaseinfoModule, // NEW
    OutboxModule,
  ],
  // همه‌ی APIها فقط برای transport_backend هستن -- هدر x-internal-api-key الزامیه.
  providers: [{ provide: APP_GUARD, useClass: InternalApiKeyGuard }],
})
export class AppModule {}