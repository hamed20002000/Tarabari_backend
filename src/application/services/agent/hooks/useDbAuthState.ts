import { In, Repository } from 'typeorm';
import { initAuthCreds, BufferJSON, proto } from '@whiskeysockets/baileys';
import type { AuthenticationState, AuthenticationCreds } from '@whiskeysockets/baileys';
import { WhatsappAuthCredential } from '../entities/WhatsappAuthCredential';
import { WhatsappAuthKey } from '../entities/WhatsappAuthKey';


/**
* A version of useMultiFileAuthState that uses PostgreSQL instead of the file system.
* This is necessary to prevent credentials from being lost whenever the server restarts—
* otherwise, you would have to scan the QR code again after every deployment.
*/

export async function useDbAuthState(
  sessionId: string,
  credentialRepo: Repository<WhatsappAuthCredential>,
  keyRepo: Repository<WhatsappAuthKey>,
): Promise<{ state: AuthenticationState; saveCreds: () => Promise<void>; flush: () => Promise<void> }> {

  //Load existing credentials from the database
  const existingCredRow = await credentialRepo.findOne({ where: { sessionId } });

  // If no existing credentials are found, initialize new credentials
  const creds: AuthenticationCreds = existingCredRow
    ? JSON.parse(existingCredRow.credsJson, BufferJSON.reviver)
    : initAuthCreds();

  // Baileys منتظر saveCreds و keys.set نمی‌مونه. همه‌ی نوشتن‌ها پشت‌سرهم توی
  // یه زنجیره می‌رن تا ترتیبشون حفظ بشه، و قبل از اتصال مجدد یا خاموش شدن
  // با flush صبر می‌کنیم تا تموم بشن -- وگرنه نشست ناقص توی دیتابیس می‌موند.
  let pending: Promise<void> = Promise.resolve();
  const enqueue = (task: () => Promise<void>): Promise<void> => {
    const run = pending.then(task);
    pending = run.catch(() => undefined);
    return run;
  };

  // Save the credentials to the database if they are new
  const saveCreds = () =>
    enqueue(async () => {
      const credsJson = JSON.stringify(creds, BufferJSON.replacer);
      await credentialRepo.upsert({ sessionId, credsJson }, ['sessionId']);
    });

  // Create the authentication state object with methods to get and set keys in the database
  const state: AuthenticationState = {
    creds,
    keys: {
      get: async (type: string, ids: string[]) => {
        const result: Record<string, any> = {};
        if (ids.length === 0) return result;

        const rows = await keyRepo.find({
          where: { sessionId, keyType: type, keyId: In(ids) },
        });

        for (const row of rows) {
          let value = JSON.parse(row.valueJson, BufferJSON.reviver);
          // مثل useMultiFileAuthState؛ بدون این، sync وضعیت اپ بعد از ری‌استارت خراب می‌شد.
          if (type === 'app-state-sync-key' && value) {
            value = proto.Message.AppStateSyncKeyData.fromObject(value);
          }
          result[row.keyId] = value;
        }
        return result;
      },
      set: (data: Record<string, Record<string, any>>) =>
        // تراکنش: اگه وسط نوشتن برنامه بسته بشه، نصفه‌ی کلیدها ذخیره نمی‌شه.
        enqueue(() =>
          keyRepo.manager.transaction(async (manager) => {
            const repo = manager.getRepository(WhatsappAuthKey);
            for (const keyType of Object.keys(data)) {
              const idMap = data[keyType];
              for (const keyId of Object.keys(idMap)) {
                const value = idMap[keyId];
                if (value === null || value === undefined) {
                  await repo.delete({ sessionId, keyType, keyId });
                } else {
                  const valueJson = JSON.stringify(value, BufferJSON.replacer);
                  await repo.upsert(
                    { sessionId, keyType, keyId, valueJson },
                    ['sessionId', 'keyType', 'keyId'],
                  );
                }
              }
            }
          }),
        ),
    } as any,
  };

  return { state, saveCreds, flush: () => pending };
}
