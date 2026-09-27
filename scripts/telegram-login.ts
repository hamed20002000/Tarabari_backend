/**
 * لاگین یک‌باره‌ی اکانت کاربری تلگرام برای مانیتورینگ گروه/کانال‌های بار.
 *
 *   npm run telegram:login
 *
 * شماره، کد تایید و (در صورت فعال بودن) رمز دو مرحله‌ای رو می‌پرسه و نشست رو
 * در جدول telegram_user_session ذخیره می‌کنه. بعد از اون سرویس بدون نیاز به
 * لاگین دوباره وصل می‌شه.
 */
import { config } from 'dotenv';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { DataSource } from 'typeorm';
import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { LogLevel } from 'telegram/extensions/Logger';
import { TelegramUserSession } from '../src/application/services/agent/entities/TelegramUserSession';
import {
  TELEGRAM_SESSION_ID,
  buildTelegramClientParams,
  getTelegramApiCredentials,
} from '../src/application/services/agent/services/telegramClient.config';

config();

async function main() {
  const credentials = getTelegramApiCredentials();
  if (!credentials) {
    throw new Error('TELEGRAM_API_ID و TELEGRAM_API_HASH رو در .env تنظیم کنید (از my.telegram.org).');
  }

  const dataSource = new DataSource({
    type: 'postgres',
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 5432,
    username: process.env.DB_USERNAME || 'postgres',
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE,
    entities: [TelegramUserSession],
    synchronize: false,
  });
  await dataSource.initialize();
  const repo = dataSource.getRepository(TelegramUserSession);

  const existing = await repo.findOne({ where: { sessionId: TELEGRAM_SESSION_ID } });
  const rl = createInterface({ input: stdin, output: stdout });

  if (existing) {
    const answer = await rl.question('یک نشست ذخیره‌شده وجود داره. جایگزین بشه؟ (y/N) ');
    if (answer.trim().toLowerCase() !== 'y') {
      rl.close();
      await dataSource.destroy();
      return;
    }
  }

  const client = new TelegramClient(
    new StringSession(''),
    credentials.apiId,
    credentials.apiHash,
    buildTelegramClientParams(),
  );
  client.setLogLevel(LogLevel.ERROR);

  await client.start({
    phoneNumber: () => rl.question('شماره تلفن (با کد کشور، مثلاً +98912...): '),
    phoneCode: () => rl.question('کد تایید ارسال‌شده در تلگرام: '),
    password: () => rl.question('رمز دو مرحله‌ای (Two-Step Verification): '),
    onError: (err) => {
      console.error('خطا:', err.message);
    },
  });

  const session = client.session.save() as unknown as string;
  await repo.save({ sessionId: TELEGRAM_SESSION_ID, session });

  // ضد بن/اسپم: فقط مخاطبین بتونن این اکانت رو به گروه اضافه کنن، تا
  // دیگران اکانت رو وارد گروه‌های اسپم نکنن.
  try {
    await client.invoke(
      new Api.account.SetPrivacy({
        key: new Api.InputPrivacyKeyChatInvite(),
        rules: [new Api.InputPrivacyValueAllowContacts()],
      }),
    );
    console.log('تنظیم حریم خصوصی: فقط مخاطبین می‌تونن این اکانت رو به گروه اضافه کنن.');
  } catch (error) {
    console.warn('تنظیم حریم خصوصی گروه‌ها ناموفق بود:', (error as Error).message);
  }

  const me = await client.getMe();
  console.log(`✅ لاگین موفق: ${me.username ? '@' + me.username : me.phone}. نشست در دیتابیس ذخیره شد.`);

  rl.close();
  await client.disconnect();
  await dataSource.destroy();
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
