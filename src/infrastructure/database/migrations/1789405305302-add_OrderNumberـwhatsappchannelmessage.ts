import { MigrationInterface, QueryRunner } from "typeorm";

export class AddOrderNumberـwhatsappchannelmessage1789405305302 implements MigrationInterface {
    name = 'AddOrderNumberـwhatsappchannelmessage1789405305302'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "whatsapp_channel_message" ADD "orderNumber" SERIAL NOT NULL`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_6229c397acbdea2abfa0bc497f" ON "whatsapp_channel_message" ("orderNumber") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_6229c397acbdea2abfa0bc497f"`);
        await queryRunner.query(`ALTER TABLE "whatsapp_channel_message" DROP COLUMN "orderNumber"`);
    }

}
