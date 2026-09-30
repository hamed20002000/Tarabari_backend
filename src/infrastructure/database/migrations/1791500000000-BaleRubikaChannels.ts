import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * جدول‌های گروه/کانال و پیام‌های بارِ بله و روبیکا -- هم‌ساختار با جدول‌های
 * تلگرام، با این تفاوت که chatId و messageId متنی هستن (guid روبیکا، rid بله).
 * جدول نشست تلگرام هم عمومی می‌شه (messenger_session) و کلید هر نشست اسم
 * پلتفرمشه؛ نشست فعلی تلگرام از main به telegram منتقل می‌شه.
 */
const PLATFORMS = ['bale', 'rubika'];

export class BaleRubikaChannels1791500000000 implements MigrationInterface {
    name = 'BaleRubikaChannels1791500000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        for (const platform of PLATFORMS) {
            const channel = `${platform}_monitored_channel`;
            const message = `${platform}_channel_message`;

            await queryRunner.query(`CREATE TYPE "public"."${channel}_type_enum" AS ENUM('group', 'channel')`);
            await queryRunner.query(`CREATE TYPE "public"."${channel}_role_enum" AS ENUM('source', 'destination', 'both')`);
            await queryRunner.query(`CREATE TABLE "${channel}" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "identifier" character varying,
                "chatId" character varying,
                "type" "public"."${channel}_type_enum" NOT NULL DEFAULT 'group',
                "role" "public"."${channel}_role_enum" NOT NULL DEFAULT 'source',
                "ownerUserIds" text array NOT NULL DEFAULT '{}',
                "label" character varying,
                "isActive" boolean NOT NULL DEFAULT true,
                "isMember" boolean NOT NULL DEFAULT false,
                "joinRequestPending" boolean NOT NULL DEFAULT false,
                "lastError" text,
                "retryCount" integer NOT NULL DEFAULT 0,
                "nextAttemptAt" TIMESTAMP WITH TIME ZONE,
                "lastJoinAttemptAt" TIMESTAMP WITH TIME ZONE,
                "joinedAt" TIMESTAMP WITH TIME ZONE,
                "membershipStatus" character varying(20) NOT NULL DEFAULT 'queued',
                "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                CONSTRAINT "PK_${channel}_id" PRIMARY KEY ("id"))`);
            await queryRunner.query(`CREATE UNIQUE INDEX "UQ_${channel}_identifier" ON "${channel}" ("identifier")`);
            await queryRunner.query(`CREATE UNIQUE INDEX "UQ_${channel}_chatId" ON "${channel}" ("chatId")`);
            await queryRunner.query(`CREATE INDEX "IDX_${channel}_ownerUserIds" ON "${channel}" USING GIN ("ownerUserIds")`);

            await queryRunner.query(`CREATE TABLE "${message}" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "code" character varying(20) NOT NULL,
                "chatId" character varying NOT NULL,
                "messageId" character varying NOT NULL,
                "rawText" text NOT NULL,
                "confidence" double precision,
                "foundPhoneNumbers" text,
                "receivedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                CONSTRAINT "PK_${message}_id" PRIMARY KEY ("id"))`);
            await queryRunner.query(`CREATE UNIQUE INDEX "UQ_${message}_code" ON "${message}" ("code")`);
            await queryRunner.query(`CREATE INDEX "IDX_${message}_chatId" ON "${message}" ("chatId")`);
            await queryRunner.query(`CREATE UNIQUE INDEX "UQ_${message}_chat_message" ON "${message}" ("chatId", "messageId")`);
        }

        await queryRunner.query(`ALTER TABLE "telegram_user_session" RENAME TO "messenger_session"`);
        await queryRunner.query(`UPDATE "messenger_session" SET "sessionId" = 'telegram' WHERE "sessionId" = 'main'`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DELETE FROM "messenger_session" WHERE "sessionId" IN ('bale', 'rubika')`);
        await queryRunner.query(`UPDATE "messenger_session" SET "sessionId" = 'main' WHERE "sessionId" = 'telegram'`);
        await queryRunner.query(`ALTER TABLE "messenger_session" RENAME TO "telegram_user_session"`);

        for (const platform of [...PLATFORMS].reverse()) {
            await queryRunner.query(`DROP TABLE "${platform}_channel_message"`);
            await queryRunner.query(`DROP TABLE "${platform}_monitored_channel"`);
            await queryRunner.query(`DROP TYPE "public"."${platform}_monitored_channel_role_enum"`);
            await queryRunner.query(`DROP TYPE "public"."${platform}_monitored_channel_type_enum"`);
        }
    }

}
