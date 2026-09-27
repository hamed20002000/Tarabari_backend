import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateTelegramChannelTables1790600000000 implements MigrationInterface {
    name = 'CreateTelegramChannelTables1790600000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TYPE "public"."telegram_monitored_channel_type_enum" AS ENUM('group', 'channel')`);
        await queryRunner.query(`CREATE TYPE "public"."telegram_monitored_channel_role_enum" AS ENUM('source', 'destination', 'both')`);
        await queryRunner.query(`CREATE TABLE "telegram_monitored_channel" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "identifier" character varying, "chatId" bigint, "type" "public"."telegram_monitored_channel_type_enum" NOT NULL DEFAULT 'group', "role" "public"."telegram_monitored_channel_role_enum" NOT NULL DEFAULT 'source', "label" character varying, "isActive" boolean NOT NULL DEFAULT true, "isMember" boolean NOT NULL DEFAULT false, "lastError" text, "retryCount" integer NOT NULL DEFAULT 0, "nextAttemptAt" TIMESTAMP, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_telegram_monitored_channel_id" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "UQ_telegram_monitored_channel_identifier" ON "telegram_monitored_channel" ("identifier") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "UQ_telegram_monitored_channel_chatId" ON "telegram_monitored_channel" ("chatId") `);

        await queryRunner.query(`CREATE TABLE "telegram_channel_message" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "chatId" bigint NOT NULL, "messageId" integer NOT NULL, "rawText" text NOT NULL, "confidence" double precision, "foundPhoneNumbers" text, "receivedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_telegram_channel_message_id" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_telegram_channel_message_chatId" ON "telegram_channel_message" ("chatId") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "UQ_telegram_channel_message_chat_message" ON "telegram_channel_message" ("chatId", "messageId") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."UQ_telegram_channel_message_chat_message"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_telegram_channel_message_chatId"`);
        await queryRunner.query(`DROP TABLE "telegram_channel_message"`);
        await queryRunner.query(`DROP INDEX "public"."UQ_telegram_monitored_channel_chatId"`);
        await queryRunner.query(`DROP INDEX "public"."UQ_telegram_monitored_channel_identifier"`);
        await queryRunner.query(`DROP TABLE "telegram_monitored_channel"`);
        await queryRunner.query(`DROP TYPE "public"."telegram_monitored_channel_role_enum"`);
        await queryRunner.query(`DROP TYPE "public"."telegram_monitored_channel_type_enum"`);
    }

}
