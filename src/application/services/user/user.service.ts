import { BadRequestException, HttpException, HttpStatus, Injectable, Inject, forwardRef } from '@nestjs/common';

import { BaseService } from '../base.service';
import { UserRepository } from 'src/infrastructure/repositories/user/user.repository';
import { Users } from 'src/domain/entities/Users';



import { ToolRegister } from '../agent/toolRegister';
import { ContextManager } from '../agent/contextManager';


@Injectable()
export class UserService extends BaseService<Users> {
  constructor(

    private readonly userRepository: UserRepository,


  ) {
    super(userRepository);
  }





  async remove(id: string): Promise<void> {
    await this.userRepository.remove(id);
  }


  async getAllUserWithRoleAndOperations(): Promise<Users[]> {
    return this.userRepository.getAllUserWithRoleAndOperations();
  }
  async getUserWithRoleAndOperations(userId: string): Promise<Users> {
    return this.userRepository.getUserWithRoleAndOperations(userId);
  }

 
  async getByUserName(username: string): Promise<Users> {
    return await this.userRepository.getByUserName(username);
  }
    async getByUserId(userid: string): Promise<Users> {
    return await this.userRepository.findByStringId(userid);
  }

    async validateCredentials(username: string,password:string): Promise<Users> {
    return await this.userRepository.validateCredentials(username,password);
  }
   async getByUserNamePass(username: string, password: string): Promise<Users> {
    return await this.userRepository.getByUserNamePass(username, password);
  }

}
