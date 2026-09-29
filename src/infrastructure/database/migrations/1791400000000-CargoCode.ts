import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * کد پیگیری بار (TRB + عدد) برای پیام‌های بار واتساپ و تلگرام. هر دو جدول
 * از یه sequence مشترک استفاده می‌کنن تا کدها بین پلتفرم‌ها تکراری نشن.
 */
export class CargoCode1791400000000 implements MigrationInterface {
    name = 'CargoCode1791400000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE SEQUENCE "cargo_code_seq" START WITH 100000`);

        for (const table of ['whatsapp_channel_message', 'telegram_channel_message']) {
            await queryRunner.query(`ALTER TABLE "${table}" ADD "code" character varying(20)`);
            // بارهای قبلی به ترتیب زمان دریافت کد می‌گیرن.
            await queryRunner.query(`UPDATE "${table}" t SET "code" = 'TRB' || nextval('cargo_code_seq')
                FROM (SELECT "id" FROM "${table}" ORDER BY "receivedAt") o WHERE t."id" = o."id"`);
            await queryRunner.query(`ALTER TABLE "${table}" ALTER COLUMN "code" SET NOT NULL`);
            await queryRunner.query(`CREATE UNIQUE INDEX "UQ_${table}_code" ON "${table}" ("code")`);
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        for (const table of ['telegram_channel_message', 'whatsapp_channel_message']) {
            await queryRunner.query(`DROP INDEX "UQ_${table}_code"`);
            await queryRunner.query(`ALTER TABLE "${table}" DROP COLUMN "code"`);
        }
        await queryRunner.query(`DROP SEQUENCE "cargo_code_seq"`);
    }

}
