import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateNewTableForWhatsapp21789278325971 implements MigrationInterface {
    name = 'CreateNewTableForWhatsapp21789278325971'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TYPE "public"."monitored_channel_type_enum" AS ENUM('group', 'channel')`);
        await queryRunner.query(`ALTER TABLE "monitored_channel" ADD "type" "public"."monitored_channel_type_enum" NOT NULL DEFAULT 'group'`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "monitored_channel" DROP COLUMN "type"`);
        await queryRunner.query(`DROP TYPE "public"."monitored_channel_type_enum"`);
    }

}
