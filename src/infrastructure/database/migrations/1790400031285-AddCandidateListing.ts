import { MigrationInterface, QueryRunner } from "typeorm";

export class AddCandidateListing1790400031285 implements MigrationInterface {
    name = 'AddCandidateListing1790400031285'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_6229c397acbdea2abfa0bc497f"`);
        await queryRunner.query(`CREATE TYPE "public"."candidate_listing_status_enum" AS ENUM('pending', 'selected', 'expired')`);
        await queryRunner.query(`CREATE TABLE "candidate_listing" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "rawMessageId" character varying NOT NULL, "orderNumber" SERIAL NOT NULL, "origin" character varying, "destination" character varying, "cargoType" character varying, "weight" character varying, "vehicleType" character varying, "price" character varying, "extraNotes" text, "status" "public"."candidate_listing_status_enum" NOT NULL DEFAULT 'pending', "selectedByCompanyId" character varying, "selectedByCompanyName" character varying, "selectedByCompanyPhone" character varying, "selectedAt" TIMESTAMP, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_772044099e85b23f17cca48ddf3" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_fd97a4b4128720bfc86adfd354" ON "candidate_listing" ("rawMessageId") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_3a1b7a2196015a336b79ff6e78" ON "candidate_listing" ("orderNumber") `);
        await queryRunner.query(`CREATE INDEX "IDX_c701da0b4b8adbd184d4b29166" ON "candidate_listing" ("status") `);
        await queryRunner.query(`ALTER TABLE "whatsapp_channel_message" DROP COLUMN "processedText"`);
        await queryRunner.query(`ALTER TABLE "whatsapp_channel_message" DROP COLUMN "orderNumber"`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "whatsapp_channel_message" ADD "orderNumber" SERIAL NOT NULL`);
        await queryRunner.query(`ALTER TABLE "whatsapp_channel_message" ADD "processedText" text`);
        await queryRunner.query(`DROP INDEX "public"."IDX_c701da0b4b8adbd184d4b29166"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_3a1b7a2196015a336b79ff6e78"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_fd97a4b4128720bfc86adfd354"`);
        await queryRunner.query(`DROP TABLE "candidate_listing"`);
        await queryRunner.query(`DROP TYPE "public"."candidate_listing_status_enum"`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_6229c397acbdea2abfa0bc497f" ON "whatsapp_channel_message" ("orderNumber") `);
    }

}
