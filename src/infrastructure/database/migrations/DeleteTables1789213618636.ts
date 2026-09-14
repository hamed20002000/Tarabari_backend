import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateTarabariTable1789213618636 implements MigrationInterface {
    name = 'CreateTarabariTable1789213618636'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE IF EXISTS "CarFuels" CASCADE`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
    }

}
