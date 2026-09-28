import { MigrationInterface, QueryRunner } from "typeorm";

// trabari کاربر نداره -- کاربرها در transport_backend هستن و ownerUserIds به User.id اون اشاره می‌کنه.
export class DropUsers1791100000000 implements MigrationInterface {
    name = 'DropUsers1791100000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE "Users"`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "Users" ("Id" uuid NOT NULL DEFAULT uuid_generate_v4(), "ImageSrc" character varying, "Username" character varying(150) NOT NULL, "Password" character varying NOT NULL, "CreateAt" TIMESTAMP WITH TIME ZONE NOT NULL, "RecordStatus" smallint NOT NULL, "UserId" uuid, "Phone" character varying(20), CONSTRAINT "Users_pkey" PRIMARY KEY ("Id"))`);
    }

}
