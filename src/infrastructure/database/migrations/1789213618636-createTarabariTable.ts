import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateTarabariTable1789213618636 implements MigrationInterface {
    name = 'CreateTarabariTable1789213618636'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "monitored_channel" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "identifier" character varying NOT NULL, "resolvedJid" character varying, "label" character varying, "isActive" boolean NOT NULL DEFAULT true, "isFollowed" boolean NOT NULL DEFAULT false, "lastError" text, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_f45ab5c90c1814df6785c8d71d7" UNIQUE ("identifier"), CONSTRAINT "PK_84af138234d287a00de1a6b23ee" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TABLE "whatsapp_channel_message" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "channelJid" character varying NOT NULL, "messageId" character varying NOT NULL, "rawText" text NOT NULL, "isCargoOrder" boolean, "confidence" double precision, "processedText" text, "foundPhoneNumbers" text, "receivedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_678b82d8d5eae1a11b2937cb6d8" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_dcbc693405bf6735ef99b9afa6" ON "whatsapp_channel_message" ("channelJid") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_3dc973997cdac062122c7f1794" ON "whatsapp_channel_message" ("messageId") `);
        await queryRunner.query(`DROP TABLE IF EXISTS "Categories" CASCADE`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_3dc973997cdac062122c7f1794"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_dcbc693405bf6735ef99b9afa6"`);
        await queryRunner.query(`DROP TABLE "whatsapp_channel_message"`);
        await queryRunner.query(`DROP TABLE "monitored_channel"`);
    }

}
