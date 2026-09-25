import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { RabbitMQModule } from '@golevelup/nestjs-rabbitmq';

@Module({
  imports: [
    RabbitMQModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        exchanges: [
          {
            name: 'cargo_events',
            type: 'topic',
          },
        ],
        uri: configService.get<string>('RABBITMQ_URL', 'amqp://guest:guest@localhost:5672'),
        connectionInitOptions: { wait: true },
      }),
    }),
  ],
  exports: [RabbitMQModule],
})
export class AppRabbitMQModule {}