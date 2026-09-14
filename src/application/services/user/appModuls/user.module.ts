import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserService } from 'src/application/services/user/user.service';
import { UserRepository } from 'src/infrastructure/repositories/user/user.repository';
import { Users } from 'src/domain/entities/Users';
import { BaseRepository } from 'src/infrastructure/repositories/base.repository';
import { AuthModule } from 'src/auth/auth.module';


@Module({
  imports: [
    TypeOrmModule.forFeature([Users]),
    forwardRef(() => AuthModule),
  ],
  controllers: [],
  providers: [
    UserService,
    BaseRepository,
    UserRepository,
  ],
  exports: [UserRepository, UserService
  ]
})
export class UserModule { }
