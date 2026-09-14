import { MigrationInterface, QueryRunner } from "typeorm";

export class UpdatemonitoredchannelRole1789328896664 implements MigrationInterface {
    name = 'UpdatemonitoredchannelRole1789328896664'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TYPE "public"."monitored_channel_role_enum" AS ENUM('source', 'destination', 'both')`);
        await queryRunner.query(`ALTER TABLE "monitored_channel" ADD "role" "public"."monitored_channel_role_enum" NOT NULL DEFAULT 'source'`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "monitored_channel" DROP COLUMN "role"`);
        await queryRunner.query(`DROP TYPE "public"."monitored_channel_role_enum"`);
    }

}
