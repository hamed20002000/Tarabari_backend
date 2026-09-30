/**
 * بخش مشترک اسکریپت‌های لاگین اکانت کاربری (تلگرام، بله، روبیکا): اتصال به
 * دیتابیس، تایید جایگزینی نشست قبلی، و ذخیره‌ی نشست در جدول messenger_session
 * با کلید اسم پلتفرم. لاگین خود هر پلتفرم رو اسکریپت همون پلتفرم انجام می‌ده.
 */
import { config } from 'dotenv';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { DataSource } from 'typeorm';
import { MessengerSession } from '../src/application/services/agent/entities/MessengerSession';
import { AccountPlatform } from '../src/application/services/agent/common/channelMonitoring';

config();

/** برای هر سوال یک readline جدا -- تا با کتابخونه‌هایی که خودشون از stdin می‌خونن تداخل نکنه. */
export async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

export async function runLogin(
  platform: AccountPlatform,
  login: () => Promise<{ session: string; account: string }>,
): Promise<void> {
  const dataSource = new DataSource({
    type: 'postgres',
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 5432,
    username: process.env.DB_USERNAME || 'postgres',
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE,
    entities: [MessengerSession],
    synchronize: false,
  });
  await dataSource.initialize();

  try {
    const repo = dataSource.getRepository(MessengerSession);
    const existing = await repo.findOne({ where: { sessionId: platform } });
    if (existing) {
      const answer = await ask(`یک نشست ${platform} ذخیره‌شده وجود داره. جایگزین بشه؟ (y/N) `);
      if (answer.toLowerCase() !== 'y') return;
    }

    const { session, account } = await login();
    await repo.save({ sessionId: platform, session });
    console.log(`✅ لاگین موفق: ${account}. نشست ${platform} در دیتابیس ذخیره شد.`);
  } finally {
    await dataSource.destroy();
  }
}

export function runScript(main: () => Promise<void>): void {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
