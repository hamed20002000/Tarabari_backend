import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * رکوردی که بعد از عضویت معلوم می‌شه همون گروه/کانالِ یک رکورد دیگه‌ست
 * (با لینک متفاوت)، به اون رکورد اشاره می‌کنه -- ثبت بعدیِ همین لینک
 * مستقیم به رکورد اصلی اضافه می‌شه.
 */
export class ChannelMergedInto1791600000000 implements MigrationInterface {
    name = 'ChannelMergedInto1791600000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        for (const table of ['telegram_monitored_channel', 'bale_monitored_channel', 'rubika_monitored_channel']) {
            await queryRunner.query(`ALTER TABLE "${table}" ADD "mergedIntoId" uuid`);
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        for (const table of ['telegram_monitored_channel', 'bale_monitored_channel', 'rubika_monitored_channel']) {
            await queryRunner.query(`ALTER TABLE "${table}" DROP COLUMN "mergedIntoId"`);
        }
    }

}
