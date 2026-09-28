import { CanActivate, ExecutionContext, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { isUUID } from 'class-validator';
import { timingSafeEqual } from 'crypto';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { Request } from 'express';
import { AuthenticatedUser, USER_AUTH_KEY } from './userAuth.decorator';

export const INTERNAL_API_KEY_HEADER = 'x-internal-api-key';

/**
 * trabari کاربر نداره و فقط به درخواست‌های transport_backend جواب می‌ده --
 * هر درخواست HTTP باید هدر x-internal-api-key رو با مقدار INTERNAL_API_KEY
 * (مشترک بین دو سرویس) داشته باشه. اگه کلید تعریف نشده باشه همه‌ی
 * درخواست‌ها رد می‌شن (fail closed).
 *
 * استثنا: routeهایی که با @UserAuth() علامت خوردن مستقیم از فرانت صدا زده
 * می‌شن و فقط با JWT کاربر (نه کلید داخلی) قبول می‌شن.
 */
@Injectable()
export class InternalApiKeyGuard implements CanActivate {
  private readonly logger = new Logger(InternalApiKeyGuard.name);
  private readonly expectedKey: Buffer | null;
  private readonly jwt: JwtService | null;

  constructor(
    configService: ConfigService,
    private readonly reflector: Reflector,
  ) {
    const key = configService.get<string>('INTERNAL_API_KEY')?.trim();
    this.expectedKey = key ? Buffer.from(key) : null;
    if (!this.expectedKey) {
      this.logger.error('INTERNAL_API_KEY تعریف نشده -- همه‌ی درخواست‌های HTTP رد می‌شن.');
    }

    // RS256: فقط کلید عمومی transport_backend -- trabari می‌تونه توکن رو
    // بررسی کنه ولی نمی‌تونه توکن بسازه (کلید خصوصی فقط دست transport_backend هست).
    const publicKey = this.readPublicKey(configService.get<string>('JWT_PUBLIC_KEY_PATH'));
    this.jwt = publicKey
      ? new JwtService({ publicKey, verifyOptions: { algorithms: ['RS256'] } })
      : null;
    if (!this.jwt) {
      this.logger.error('کلید عمومی JWT (JWT_PUBLIC_KEY_PATH) پیدا نشد -- routeهای کاربر (@UserAuth) رد می‌شن.');
    }
  }

  private readPublicKey(path: string | undefined): string | null {
    if (!path?.trim()) return null;
    try {
      return readFileSync(resolve(process.cwd(), path.trim()), 'utf8');
    } catch (error) {
      this.logger.error(`خواندن کلید عمومی JWT ناموفق بود: ${(error as Error).message}`);
      return null;
    }
  }

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;
    const request = context.switchToHttp().getRequest<Request & { user?: AuthenticatedUser }>();

    const userRoute = this.reflector.getAllAndOverride<boolean>(USER_AUTH_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (userRoute) {
      request.user = this.verifyUser(request);
      return true;
    }

    const provided = request.header(INTERNAL_API_KEY_HEADER);
    if (this.expectedKey && provided) {
      const providedKey = Buffer.from(provided);
      if (providedKey.length === this.expectedKey.length && timingSafeEqual(providedKey, this.expectedKey)) {
        return true;
      }
    }
    throw new UnauthorizedException();
  }

  // توکن صادرشده توسط transport_backend (RS256)؛ امضا و exp اینجا بررسی می‌شن.
  private verifyUser(request: Request): AuthenticatedUser {
    const [scheme, token] = (request.header('authorization') ?? '').split(' ');
    if (!this.jwt || scheme !== 'Bearer' || !token) throw new UnauthorizedException();

    let payload: { userId?: unknown; username?: unknown; roles?: unknown; isActive?: unknown };
    try {
      payload = this.jwt.verify(token);
    } catch {
      throw new UnauthorizedException();
    }
    if (typeof payload.userId !== 'string' || !isUUID(payload.userId) || payload.isActive === false) {
      throw new UnauthorizedException();
    }
    return {
      userId: payload.userId,
      username: typeof payload.username === 'string' ? payload.username : undefined,
      roles: Array.isArray(payload.roles) ? payload.roles.filter((role): role is string => typeof role === 'string') : [],
    };
  }
}
