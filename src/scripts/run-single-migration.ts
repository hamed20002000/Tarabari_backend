// src/scripts/run-single-migration.ts
import { AppDataSource } from '../infrastructure/database/data-source';
import { CreateTarabariTable1789213618636 } from '../infrastructure/database/migrations/1789213618636-createTarabariTable';

async function runSingle() {
  await AppDataSource.initialize();
  const queryRunner = AppDataSource.createQueryRunner();

  const migration = new CreateTarabariTable1789213618636();
  await migration.up(queryRunner);

  await queryRunner.release();
  await AppDataSource.destroy();
  console.log('✅ Migration اجرا شد.');
}

runSingle();