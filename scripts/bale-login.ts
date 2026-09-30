/**
 * لاگین یک‌باره‌ی اکانت کاربری بله برای مانیتورینگ گروه/کانال‌های بار.
 *
 *   npm run bale:login
 *
 * شماره، کد تایید و (در صورت فعال بودن) رمز دو مرحله‌ای رو می‌پرسه و نشست
 * (userId:jwt) رو در جدول messenger_session ذخیره می‌کنه.
 */
import { BaleRpcError, Client } from '@hoseinbnoob/balejs';
import { ask, runLogin, runScript } from './messengerLogin';

runScript(() =>
  runLogin('bale', async () => {
    const phone = await ask('شماره تلفن (با کد کشور، مثلاً +98912...): ');
    // فقط برای درخواست‌های gRPC لاگین -- به websocket وصل نمی‌شه.
    const client = new Client(phone);
    const { transaction_hash } = await client.start_phone_auth(phone);

    let auth: Record<string, any>;
    while (true) {
      try {
        auth = await client.validate_code(transaction_hash, await ask('کد تایید ارسال‌شده در بله: '));
        break;
      } catch (error) {
        if (!(error instanceof BaleRpcError)) throw error;
        if (error.message === 'PHONE_CODE_INVALID') {
          console.error('کد اشتباهه.');
          continue;
        }
        if (!error.message || /password/i.test(error.message)) {
          auth = await client.validate_password(transaction_hash, await ask('رمز دو مرحله‌ای: '));
          break;
        }
        throw error;
      }
    }

    const userId = auth.user?.id;
    const jwt = auth.jwt?.value;
    if (!userId || !jwt) throw new Error('پاسخ لاگین بله ناقصه (userId یا jwt نیومد).');
    return { session: `${userId}:${jwt}`, account: auth.user?.nick?.value ? '@' + auth.user.nick.value : phone };
  }),
);
