import { Body, Controller, HttpException, HttpStatus, Post} from '@nestjs/common';
import { AuthService } from './auth.service';
import { UserService } from 'src/application/services/user/user.service';

import { ConfigService } from '@nestjs/config';
import { ApiOperation } from 'node_modules/@nestjs/swagger/dist/decorators/api-operation.decorator';
import { ApiResponse } from 'node_modules/@nestjs/swagger/dist/decorators/api-response.decorator';
import { LoginDto } from 'src/application/services/agent/entities/Logindto';
import { recordStatus } from 'src/domain/enums/recordstatus.enum';


@Controller('api/auth')
export class AuthController {
  constructor(private authService: AuthService, private userService: UserService,
    private readonly configService: ConfigService,
   
  ) { }

    @Post('login')
  @ApiOperation({ summary: 'get token' })  // Operation description
  @ApiResponse({ status: 400, description: 'Bad request' })  // Error response
  @ApiResponse({ status: 200, description: 'Successfull login', type: String })
  async login(@Body() user: LoginDto) {


    var result = await this.authService.login(user);
    if (!result.isAuthenticate) {
      throw new HttpException(result.message, HttpStatus.UNAUTHORIZED);
    }
    return result.access_token;
  }

}
