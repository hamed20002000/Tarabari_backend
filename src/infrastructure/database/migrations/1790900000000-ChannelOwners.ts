import { MigrationInterface, QueryRunner } from "typeorm";

// هر گروه/کانال می‌تونه چند ثبت‌کننده داشته باشه -- ownerUserId به آرایه‌ی ownerUserIds تبدیل می‌شه.
export class ChannelOwners1790900000000 implements MigrationInterface {
    name = 'ChannelOwners1790900000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        for (const table of ['telegram_monitored_channel', 'monitored_channel']) {
            await queryRunner.query(`ALTER TABLE "${table}" ADD "ownerUserIds" text array NOT NULL DEFAULT '{}'`);
            await queryRunner.query(`UPDATE "${table}" SET "ownerUserIds" = ARRAY["ownerUserId"] WHERE "ownerUserId" IS NOT NULL`);
            await queryRunner.query(`DROP INDEX "public"."IDX_${table}_ownerUserId"`);
            await queryRunner.query(`ALTER TABLE "${table}" DROP COLUMN "ownerUserId"`);
            await queryRunner.query(`CREATE INDEX "IDX_${table}_ownerUserIds" ON "${table}" USING GIN ("ownerUserIds")`);
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        for (const table of ['monitored_channel', 'telegram_monitored_channel']) {
            await queryRunner.query(`DROP INDEX "public"."IDX_${table}_ownerUserIds"`);
            await queryRunner.query(`ALTER TABLE "${table}" ADD "ownerUserId" character varying`);
            await queryRunner.query(`UPDATE "${table}" SET "ownerUserId" = "ownerUserIds"[1]`);
            await queryRunner.query(`ALTER TABLE "${table}" DROP COLUMN "ownerUserIds"`);
            await queryRunner.query(`CREATE INDEX "IDX_${table}_ownerUserId" ON "${table}" ("ownerUserId") `);
        }
    }

}
