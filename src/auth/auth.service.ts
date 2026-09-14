import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { OAuth2Client } from 'google-auth-library';
import { Users } from 'src/domain/entities/Users';
import { recordStatus } from 'src/domain/enums/recordstatus.enum';
import { UserRepository } from 'src/infrastructure/repositories/user/user.repository';
import { FindOptionsRelations } from 'typeorm';
import { LoginDto } from 'src/application/services/agent/entities/Logindto';
import { JwtPayload, userLoginResultDto } from 'src/application/services/agent/entities/jwtpayload';
import { PasswordService } from 'src/application/services/agent/services/password.service';

@Injectable()
export class AuthService {
  constructor(private jwtService: JwtService, private userRepository: UserRepository, private readonly passwordService: PasswordService,
    private readonly configService: ConfigService
  ) { }

  async login(user: LoginDto) {
    var check = await this.validateUser(user);
    if (!check.isAuthenticate) {
      return check;
    }
    const payload = new JwtPayload(check.user);
    const plainObjectPayload = Object.assign({}, payload);
 
    check.access_token = this.jwtService.sign(plainObjectPayload);
    check.user = null;
    return check;
  }


  async loginForResetPassword(user: LoginDto) {
    var check = await this.validateUserLogginForResetPassword(user.username);
    if (!check.isAuthenticate) {
      return check;
    }
    const payload = new JwtPayload(check.user);
    const plainObjectPayload = Object.assign({}, payload);
    check.access_token = this.jwtService.sign(plainObjectPayload);
    check.user = null;
    return check;
  }
  async generateTokenWithoutLogin(user: Users) {

    const payload = new JwtPayload(user);
    const plainObjectPayload = Object.assign({}, payload);
 
    var access_token = this.jwtService.sign(plainObjectPayload);

    return access_token;
  }
  async validateUser(checkUser: LoginDto): Promise<userLoginResultDto> {

    var result = new userLoginResultDto();

    const user = await this.userRepository.getByUserName(checkUser.username);
    if (!user) {
      result.isAuthenticate = false;
      result.user = null;
      result.message = "User is not exist or is inactive!";
      return result;
    }

    if (user && user?.recordStatus == recordStatus.Active) {
      var checkPass = await this.passwordService.comparePasswords(checkUser.password, user.password);
      if (checkPass) {
        result.isAuthenticate = true;
        result.user = user;
        
        return result;  // Return user if password matches
      }
      else {
        result.isAuthenticate = false;
        result.user = null;
        result.message = "Username or Password is not corrected!";
        return result;  // Return user if password matches
      }
    }
    result.isAuthenticate = false;
    result.user = null;
    result.message = "User is not exist or is inactive!";
    return result;  // Return null if user not found or password doesn't match
  }

  async validateUserLogginForResetPassword(username: string): Promise<userLoginResultDto> {

    var result = new userLoginResultDto();
   
    
    const user = await this.userRepository.getByUserName(username);
    if (!user) {
      result.isAuthenticate = false;
      result.user = null;
      result.message = "User is not exist or is inactive!";
      return result;
    }

    if (user && user[0]?.recordStatus == recordStatus.Active) {

      result.isAuthenticate = true;
      result.user = user[0];
      return result;  // Return user if password matches

    }
    result.isAuthenticate = false;
    result.user = null;
    result.message = "User is not exist or is inactive!";
    return result;  // Return null if user not found or password doesn't match
  }
  parseJwt(token: string): any {
    try {
      // Decode the JWT payload without verifying
      const decoded = this.jwtService.decode(token);
      return decoded;
    } catch (error) {
      throw new Error('Failed to parse JWT');
    }
  }

  async verifyJwt(token: string): Promise<any> {
    try {
      // Verify the JWT with a secret or public key
      const verified = await this.jwtService.verifyAsync(token, {
        secret: this.configService.get<string>('JWT_SECRET_KEY', 'ad;,pwqdpoqwkdopkwqopdqwpdkqwd65165dw1q5d1wqd;wq,dqwdASDwqd'), // Use your actual secret
      });
      return verified;
    } catch (error) {
      throw new Error('Invalid or expired JWT');
    }
  }

 
}
