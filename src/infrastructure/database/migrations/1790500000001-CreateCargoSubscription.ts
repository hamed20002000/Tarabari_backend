import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateCargoSubscription1790500000001 implements MigrationInterface {
    name = 'CreateCargoSubscription1790500000001'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "cargo_subscription" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "subscriberId" character varying NOT NULL, "label" character varying, "origins" text array NOT NULL DEFAULT '{}', "destinations" text array NOT NULL DEFAULT '{}', "cargoTypes" text array NOT NULL DEFAULT '{}', "vehicleTypes" text array NOT NULL DEFAULT '{}', "isActive" boolean NOT NULL DEFAULT true, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_cargo_subscription_id" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_cargo_subscription_subscriberId" ON "cargo_subscription" ("subscriberId") `);
        await queryRunner.query(`CREATE INDEX "IDX_cargo_subscription_isActive" ON "cargo_subscription" ("isActive") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_cargo_subscription_isActive"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_cargo_subscription_subscriberId"`);
        await queryRunner.query(`DROP TABLE "cargo_subscription"`);
    }

}
