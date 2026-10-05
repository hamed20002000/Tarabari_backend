import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * یک پیام ممکنه چند بار (چند مسیر مستقل) داشته باشه -- هر بار یک رکورد با
 * cargoIndex (ترتیبش در پیام) ذخیره می‌شه و یکتایی پیام به (پیام، cargoIndex) تغییر می‌کنه.
 * رکوردهای قبلی همه cargoIndex = 0 می‌گیرن.
 */
export class CargoIndex1791700000000 implements MigrationInterface {
    name = 'CargoIndex1791700000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        for (const table of ['telegram_channel_message', 'bale_channel_message', 'rubika_channel_message']) {
            await queryRunner.query(`ALTER TABLE "${table}" ADD "cargoIndex" integer NOT NULL DEFAULT 0`);
            await queryRunner.query(`DROP INDEX "UQ_${table}_chat_message"`);
            await queryRunner.query(`CREATE UNIQUE INDEX "UQ_${table}_chat_message" ON "${table}" ("chatId", "messageId", "cargoIndex")`);
        }

        await queryRunner.query(`ALTER TABLE "whatsapp_channel_message" ADD "cargoIndex" integer NOT NULL DEFAULT 0`);
        await queryRunner.query(`DROP INDEX "IDX_3dc973997cdac062122c7f1794"`);
        await queryRunner.query(`CREATE UNIQUE INDEX "UQ_whatsapp_channel_message_message_cargo" ON "whatsapp_channel_message" ("messageId", "cargoIndex")`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // برگشت فقط وقتی ممکنه که پیام چندباری ذخیره نشده باشه -- بارهای اضافه‌ی هر پیام حذف می‌شن.
        await queryRunner.query(`DROP INDEX "UQ_whatsapp_channel_message_message_cargo"`);
        await queryRunner.query(`DELETE FROM "whatsapp_channel_message" WHERE "cargoIndex" > 0`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_3dc973997cdac062122c7f1794" ON "whatsapp_channel_message" ("messageId")`);
        await queryRunner.query(`ALTER TABLE "whatsapp_channel_message" DROP COLUMN "cargoIndex"`);

        for (const table of ['telegram_channel_message', 'bale_channel_message', 'rubika_channel_message']) {
            await queryRunner.query(`DROP INDEX "UQ_${table}_chat_message"`);
            await queryRunner.query(`DELETE FROM "${table}" WHERE "cargoIndex" > 0`);
            await queryRunner.query(`CREATE UNIQUE INDEX "UQ_${table}_chat_message" ON "${table}" ("chatId", "messageId")`);
            await queryRunner.query(`ALTER TABLE "${table}" DROP COLUMN "cargoIndex"`);
        }
    }

}
