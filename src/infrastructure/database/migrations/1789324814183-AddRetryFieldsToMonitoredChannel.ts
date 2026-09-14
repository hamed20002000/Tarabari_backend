import { MigrationInterface, QueryRunner } from "typeorm";

export class AddRetryFieldsToMonitoredChannel1789324814183 implements MigrationInterface {
    name = 'AddRetryFieldsToMonitoredChannel1789324814183'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "monitored_channel" ADD "retryCount" integer NOT NULL DEFAULT '0'`);
        await queryRunner.query(`ALTER TABLE "monitored_channel" ADD "nextAttemptAt" TIMESTAMP`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "monitored_channel" DROP COLUMN "nextAttemptAt"`);
        await queryRunner.query(`ALTER TABLE "monitored_channel" DROP COLUMN "retryCount"`);
    }

}
