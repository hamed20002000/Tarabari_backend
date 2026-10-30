import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * پیام‌هایی که وقتی مدل در دسترس نبود پردازش نشدن -- دوباره امتحان می‌شن تا از دست نرن.
 */
export class PendingCargoMessage1791900000000 implements MigrationInterface {
    name = 'PendingCargoMessage1791900000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "pending_cargo_message" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "label" character varying NOT NULL, "text" text NOT NULL, "isVoice" boolean NOT NULL DEFAULT false, "entityName" character varying NOT NULL, "record" jsonb NOT NULL, "source" jsonb NOT NULL, "ownerUserIds" jsonb NOT NULL, "attempts" integer NOT NULL DEFAULT 0, "nextAttemptAt" TIMESTAMP WITH TIME ZONE NOT NULL, "lastError" text, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_pending_cargo_message_id" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_pending_cargo_message_nextAttemptAt" ON "pending_cargo_message" ("nextAttemptAt")`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE "pending_cargo_message"`);
    }

}
