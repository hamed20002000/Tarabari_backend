import { MigrationInterface, QueryRunner } from "typeorm";

export class ChannelMembershipStatus1791300000000 implements MigrationInterface {
    name = 'ChannelMembershipStatus1791300000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "telegram_monitored_channel" ADD "membershipStatus" character varying(20) NOT NULL DEFAULT 'queued'`);
        await queryRunner.query(`UPDATE "telegram_monitored_channel" SET "membershipStatus" = CASE
            WHEN "isMember" THEN 'joined'
            WHEN "joinRequestPending" THEN 'pending'
            WHEN NOT "isActive" AND "lastError" IS NOT NULL THEN 'failed'
            ELSE 'queued' END`);

        await queryRunner.query(`ALTER TABLE "monitored_channel" ADD "membershipStatus" character varying(20) NOT NULL DEFAULT 'queued'`);
        await queryRunner.query(`UPDATE "monitored_channel" SET "membershipStatus" = CASE
            WHEN "isFollowed" THEN 'joined'
            WHEN NOT "isActive" AND "lastError" LIKE '%حذف شد%' THEN 'removed'
            WHEN NOT "isActive" AND "lastError" IS NOT NULL THEN 'failed'
            ELSE 'queued' END`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "monitored_channel" DROP COLUMN "membershipStatus"`);
        await queryRunner.query(`ALTER TABLE "telegram_monitored_channel" DROP COLUMN "membershipStatus"`);
    }

}
