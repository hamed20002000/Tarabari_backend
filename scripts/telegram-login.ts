/**
 * لاگین یک‌باره‌ی اکانت کاربری تلگرام برای مانیتورینگ گروه/کانال‌های بار.
 *
 *   npm run telegram:login
 *
 * شماره، کد تایید و (در صورت فعال بودن) رمز دو مرحله‌ای رو می‌پرسه و نشست رو
 * در جدول messenger_session ذخیره می‌کنه. بعد از اون سرویس بدون نیاز به
 * لاگین دوباره وصل می‌شه.
 */
import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { LogLevel } from 'telegram/extensions/Logger';
import {
  buildTelegramClientParams,
  getTelegramApiCredentials,
} from '../src/application/services/agent/services/telegramClient.config';
import { ask, runLogin, runScript } from './messengerLogin';

runScript(() =>
  runLogin('telegram', async () => {
    const credentials = getTelegramApiCredentials();
    if (!credentials) {
      throw new Error('TELEGRAM_API_ID و TELEGRAM_API_HASH رو در .env تنظیم کنید (از my.telegram.org).');
    }

    const client = new TelegramClient(
      new StringSession(''),
      credentials.apiId,
      credentials.apiHash,
      buildTelegramClientParams(),
    );
    client.setLogLevel(LogLevel.ERROR);

    await client.start({
      phoneNumber: () => ask('شماره تلفن (با کد کشور، مثلاً +98912...): '),
      phoneCode: () => ask('کد تایید ارسال‌شده در تلگرام: '),
      password: () => ask('رمز دو مرحله‌ای (Two-Step Verification): '),
      onError: (err) => {
        console.error('خطا:', err.message);
      },
    });

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
    const session = client.session.save() as unknown as string;
    await client.disconnect();
    return { session, account: me.username ? '@' + me.username : String(me.phone) };
  }),
);
