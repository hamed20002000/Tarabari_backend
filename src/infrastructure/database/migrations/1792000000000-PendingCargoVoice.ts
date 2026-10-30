import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * پیام صوتی که مدل نتونست به متن تبدیلش کنه، با خود صدا در صف تلاش دوباره می‌مونه.
 */
export class PendingCargoVoice1792000000000 implements MigrationInterface {
    name = 'PendingCargoVoice1792000000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "pending_cargo_message" ADD "audio" bytea`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "pending_cargo_message" DROP COLUMN "audio"`);
    }

}
