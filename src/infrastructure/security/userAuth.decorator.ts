import { SetMetadata } from '@nestjs/common';

export const USER_AUTH_KEY = 'userAuth';

/**
 * این route مستقیم از فرانت صدا زده می‌شه: به‌جای x-internal-api-key، توکن
 * JWT کاربر (صادرشده توسط transport_backend، امضای RS256) لازمه
 * و شناسه‌ی کاربر از خود توکن خونده می‌شه (request.user.userId).
 */
export const UserAuth = () => SetMetadata(USER_AUTH_KEY, true);

export interface AuthenticatedUser {
  userId: string;
  username?: string;
  roles: string[];
}
