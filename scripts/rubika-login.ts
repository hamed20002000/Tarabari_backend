/**
 * لاگین یک‌باره‌ی اکانت کاربری روبیکا برای مانیتورینگ گروه/کانال‌های بار.
 *
 *   npm run rubika:login
 *
 * rubjs خودش شماره، کد تایید و رمز رو از ترمینال می‌پرسه و نشست رمزشده رو در
 * یک فایل موقت می‌نویسه؛ این اسکریپت همون رو در جدول messenger_session ذخیره و
 * فایل رو پاک می‌کنه.
 */
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'rubjs';
import { runLogin, runScript } from './messengerLogin';

runScript(() =>
  runLogin('rubika', async () => {
    const sessionName = join(tmpdir(), `rubika-login-${Date.now()}`);
    const sessionFile = `${sessionName}.json`;

    try {
      // سازنده‌ی Client بلافاصله لاگین تعاملی رو شروع می‌کنه.
      const client = new Client(sessionName);
      while (!client.initialize) await new Promise((resolve) => setTimeout(resolve, 1_000));

      const session = readFileSync(sessionFile, 'utf8');
      return { session: JSON.stringify(JSON.parse(session)), account: client.userGuid ?? 'روبیکا' };
    } finally {
      rmSync(sessionFile, { force: true });
    }
  }),
);
