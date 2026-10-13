import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * تشخیص آگهی تکراری با متن (نه شناسه‌ی پیام): هر متن پردازش‌شده به ازای هر
 * ثبت‌کننده یک رکورد داره تا پست دوباره‌ی همون آگهی دوباره ارسال نشه.
 */
export class CargoTextFingerprint1791800000000 implements MigrationInterface {
    name = 'CargoTextFingerprint1791800000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "cargo_text_fingerprint" ("contentHash" character varying(64) NOT NULL, "userId" character varying NOT NULL, "seenAt" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "PK_cargo_text_fingerprint" PRIMARY KEY ("contentHash", "userId"))`);
        await queryRunner.query(`CREATE INDEX "IDX_cargo_text_fingerprint_seenAt" ON "cargo_text_fingerprint" ("seenAt")`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE "cargo_text_fingerprint"`);
    }

}
