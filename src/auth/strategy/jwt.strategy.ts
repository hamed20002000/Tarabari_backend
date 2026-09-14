import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { AuthService } from '../auth.service';
import { ConfigService } from '@nestjs/config';
import {JwtPayload} from 'src/application/services/agent/entities/jwtpayload';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(private authService: AuthService, private jwtService: JwtService,
    private configService: ConfigService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey:configService.get<string>('JWT_SECRET_KEY',configService.get<string>('JWT_SECRET_KEY','ad;,pwqdpoqwkdopkwqopdqwpdkqwd65165dw1q5d1wqd;wq,dqwdASDwqd')), // process.env.JWT_SECRET_KEY, // Use your own secret key here
    });
  }

  async validate(payload: JwtPayload) {
    return payload;
  }
}
