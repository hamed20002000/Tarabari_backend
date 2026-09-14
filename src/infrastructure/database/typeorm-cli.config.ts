import { TypeOrmModuleOptions } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';



export const typeOrmConfig = (configService: ConfigService): TypeOrmModuleOptions => ({
  type: 'postgres',
  host: configService.get<string>('DB_HOST', 'localhost'),
  port: configService.get<number>('DB_PORT', 5432),
  username: configService.get<string>('DB_USERNAME', 'postgres'),
  password: configService.get<string>('DB_PASSWORD', '123qwe$%'),
  database: configService.get<string>('DB_DATABASE', 'SETASTAKIP'),
 /*  entities: ['src/domain/entities/*.ts'], */
  entities: ['src/application/services/agent/entities/WhatsappChannelMessage.ts'],
  migrations: ['src/infrastructure/database/migrations/1789405305302-add_OrderNumberـwhatsappchannelmessage.ts'],  
  migrationsRun: false,   
  synchronize: false, // Disable auto schema synchronization
  logging:true// ['error'], // Log only errors
  
});


