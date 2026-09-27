import { MigrationInterface, QueryRunner } from "typeorm";

export class TelegramUserAccount1790700000000 implements MigrationInterface {
    name = 'TelegramUserAccount1790700000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "telegram_user_session" ("sessionId" character varying(100) NOT NULL, "session" text NOT NULL, "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_telegram_user_session_sessionId" PRIMARY KEY ("sessionId"))`);
        await queryRunner.query(`ALTER TABLE "telegram_monitored_channel" ADD "joinRequestPending" boolean NOT NULL DEFAULT false`);
        await queryRunner.query(`ALTER TABLE "telegram_monitored_channel" ADD "lastJoinAttemptAt" TIMESTAMP`);
        await queryRunner.query(`ALTER TABLE "telegram_monitored_channel" ADD "joinedAt" TIMESTAMP`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "telegram_monitored_channel" DROP COLUMN "joinedAt"`);
        await queryRunner.query(`ALTER TABLE "telegram_monitored_channel" DROP COLUMN "lastJoinAttemptAt"`);
        await queryRunner.query(`ALTER TABLE "telegram_monitored_channel" DROP COLUMN "joinRequestPending"`);
        await queryRunner.query(`DROP TABLE "telegram_user_session"`);
    }

}
