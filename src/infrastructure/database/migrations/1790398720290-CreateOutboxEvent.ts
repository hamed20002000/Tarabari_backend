import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateOutboxEvent1790398720290 implements MigrationInterface {
    name = 'CreateOutboxEvent1790398720290'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "outbox_event" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "eventType" character varying NOT NULL, "payload" jsonb NOT NULL, "published" boolean NOT NULL DEFAULT false, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_cc0c9e40998e45ecfc5e313429d" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_a899e9a8380979d8e85caaf721" ON "outbox_event" ("published") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_a899e9a8380979d8e85caaf721"`);
        await queryRunner.query(`DROP TABLE "outbox_event"`);
    }

}
