import { MigrationInterface, QueryRunner } from "typeorm";

export class ChannelOwner1790800000000 implements MigrationInterface {
    name = 'ChannelOwner1790800000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "telegram_monitored_channel" ADD "ownerUserId" character varying`);
        await queryRunner.query(`CREATE INDEX "IDX_telegram_monitored_channel_ownerUserId" ON "telegram_monitored_channel" ("ownerUserId") `);
        await queryRunner.query(`ALTER TABLE "monitored_channel" ADD "ownerUserId" character varying`);
        await queryRunner.query(`CREATE INDEX "IDX_monitored_channel_ownerUserId" ON "monitored_channel" ("ownerUserId") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_monitored_channel_ownerUserId"`);
        await queryRunner.query(`ALTER TABLE "monitored_channel" DROP COLUMN "ownerUserId"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_telegram_monitored_channel_ownerUserId"`);
        await queryRunner.query(`ALTER TABLE "telegram_monitored_channel" DROP COLUMN "ownerUserId"`);
    }

}
