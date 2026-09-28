import { MigrationInterface, QueryRunner } from "typeorm";

export class UserPhone1791000000000 implements MigrationInterface {
    name = 'UserPhone1791000000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "Users" ADD "Phone" character varying(20)`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "Users" DROP COLUMN "Phone"`);
    }

}
