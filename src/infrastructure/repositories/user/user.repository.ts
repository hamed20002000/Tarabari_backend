import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';


import { BaseRepository } from '../base.repository';
import { DataSource, EntityManager, In, QueryRunner, Repository } from 'typeorm';
import { Users } from 'src/domain/entities/Users';


import { recordStatus } from 'src/domain/enums/recordstatus.enum';





@Injectable()
export class UserRepository extends BaseRepository<Users> {
  constructor(@InjectRepository(Users) repository: Repository<Users>, private readonly dataSource: DataSource) {
    super(repository);
  }




  async remove(id: string): Promise<void> {
    await this.repository.delete(id);
  }

  async getAllUserWithRoleAndOperations(): Promise<Users[]> {
    return this.repository.find({
      relations: ['userMenuOperations', 'userMenuOperations.menuOperation','userMenuOperations.menuOperation.systemOperation', 'userRoles', 'userRoles.role'],
    });
  }

  async getUserWithRoleAndOperations(userId: string): Promise<Users> {
    return this.repository.findOne({
      where: { id: userId },
      relations: ['userMenuOperations', 'userMenuOperations.menuOperation','userMenuOperations.menuOperation.systemOperation', 'userRoles', 'userRoles.role'],
    } as any);
  }


      async getByUserName(username: string): Promise<Users> {
      return await this.repository.findOne({where:{username}})
    }
  
   async validateCredentials(username: string,password:string): Promise<Users> {
      return await this.repository.findOne({where:{username,password}})
    }
       async getByUserNamePass(username: string, password: string): Promise<Users> {
      return await this.repository.findOne({where:{username,password}})
    }

}
