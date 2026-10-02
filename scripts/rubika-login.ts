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

/** سرور روبیکا شماره رو فقط به شکل 98xxxxxxxxxx قبول می‌کنه (09… یا +98… → INVALID_INPUT). */
function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.startsWith('0')) return `98${digits.slice(1)}`;
  if (digits.startsWith('9') && digits.length === 10) return `98${digits}`;
  return digits;
}

/**
 * rubjs شماره رو بدون تبدیل می‌فرسته و وقتی سرور خطا بده به‌جای خطا undefined
 * برمی‌گردونه (که بعدش با «reading 'status'» می‌ترکه)؛ اینجا هر دو رو جبران می‌کنیم.
 */
class LoginClient extends Client {
  async sendCode(phone: string, passKey?: string, sendType?: 'SMS' | 'Internal') {
    const result = await super.sendCode(normalizePhone(phone), passKey, sendType);
    if (!result) throw new Error('روبیکا درخواست ارسال کد رو رد کرد (شماره یا رمز نامعتبر / محدودیت موقت).');
    return result;
  }

  async signIn(code: string, phone: string, codeHash: string, publicKey: string) {
    const result = await super.signIn(code, normalizePhone(phone), codeHash, publicKey);
    if (!result) throw new Error('روبیکا ورود رو رد کرد (کد نامعتبر یا منقضی).');
    return result;
  }
}

runScript(() =>
  runLogin('rubika', async () => {
    const sessionName = join(tmpdir(), `rubika-login-${Date.now()}`);
    const sessionFile = `${sessionName}.json`;

    try {
      // سازنده‌ی Client بلافاصله لاگین تعاملی رو شروع می‌کنه.
      const client = new LoginClient(sessionName);
      while (!client.initialize) await new Promise((resolve) => setTimeout(resolve, 1_000));

      // ضد بن/اسپم (مثل تلگرام): فقط مخاطبین بتونن این اکانت رو به گروه اضافه
      // کنن، تا دیگران اکانت رو وارد گروه‌های اسپم نکنن.
      const privacy = await client.setSetting(undefined, undefined, undefined, undefined, 'MyContacts');
      if (privacy) console.log('تنظیم حریم خصوصی: فقط مخاطبین می‌تونن این اکانت رو به گروه اضافه کنن.');
      else console.warn('تنظیم حریم خصوصی گروه‌ها ناموفق بود.');

      const session = readFileSync(sessionFile, 'utf8');
      return { session: JSON.stringify(JSON.parse(session)), account: client.userGuid ?? 'روبیکا' };
    } finally {
      rmSync(sessionFile, { force: true });
    }
  }),
);
