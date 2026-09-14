// src/scripts/drop-tables-except.ts
import { AppDataSource} from '../infrastructure/database/data-source' ; // مسیر واقعی data-source خودتون

// اسم جدول‌هایی که می‌خواید نگه دارید (دقیقاً همون‌طور که در دیتابیس هستن，
// با همون حروف بزرگ/کوچک -- چک کنید از \dt در psql)
const TABLES_TO_KEEP = [
  'migrations',           // همیشه نگه دارید، وگرنه TypeORM تاریخچه‌ی migration رو گم می‌کنه
  'WhatsappAuthCredential',
  'WhatsappAuthKey',
  'WhatsappUserMapping',
  'monitored_channel',
  'Users',
  'whatsapp_channel_message'
  // بقیه‌ی جدول‌هایی که می‌خواید نگه دارید رو اینجا اضافه کنید
];

async function dropTablesExcept() {
  await AppDataSource.initialize();
  const queryRunner = AppDataSource.createQueryRunner();

  try {
    // گرفتن لیست همه‌ی جدول‌های schema فعلی (معمولاً public)
    const result = await queryRunner.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    `);

    const allTables: string[] = result.map((r: any) => r.table_name);

    // فقط جدول‌هایی که در لیست نگه‌داری نیستن رو نگه می‌داریم برای حذف
    const tablesToDrop = allTables.filter(
      (table) => !TABLES_TO_KEEP.includes(table),
    );

    if (tablesToDrop.length === 0) {
      console.log('هیچ جدولی برای حذف پیدا نشد.');
      return;
    }

    console.log('جدول‌های زیر حذف خواهند شد:');
    tablesToDrop.forEach((t) => console.log(`  - ${t}`));

    for (const table of tablesToDrop) {
      // CASCADE برای حذف اجباری، حتی اگه جدول دیگه‌ای بهش وابسته باشه
      await queryRunner.query(`DROP TABLE IF EXISTS "${table}" CASCADE`);
      console.log(`✅ حذف شد: ${table}`);
    }

    console.log('\n🎉 عملیات کامل شد.');
  } catch (error) {
    console.error('خطا در حذف جدول‌ها:', error);
  } finally {
    await queryRunner.release();
    await AppDataSource.destroy();
  }
}

dropTablesExcept();