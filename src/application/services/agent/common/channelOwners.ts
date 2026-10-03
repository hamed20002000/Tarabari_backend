import { QueryFailedError, Raw, Repository } from 'typeorm';
import { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';

type OwnedChannel = { id: string; ownerUserIds: string[] };

/**
 * تغییر ownerUserIds به‌صورت اتمیک در خود دیتابیس. خوندن آرایه، تغییرش در
 * برنامه و ذخیره‌ی کامل اون، با دو درخواست هم‌زمان (مثلاً دو شرکت که با هم
 * یک لینک رو ثبت می‌کنن) باعث می‌شد یکی از ثبت‌کننده‌ها بی‌صدا گم بشه.
 */

/** فیلتر find برای ownerUserIds: حداقل یک ثبت‌کننده داره. */
export const HAS_OWNERS = Raw((column) => `cardinality(${column}) > 0`);

/** @returns true اگه کاربر اضافه شد، false اگه از قبل ثبت‌کننده بود. */
export async function addChannelOwner<T extends OwnedChannel>(repo: Repository<T>, id: string, userId: string): Promise<boolean> {
  const result = await repo
    .createQueryBuilder()
    .update()
    .set({ ownerUserIds: () => 'array_append("ownerUserIds", CAST(:userId AS text))' } as QueryDeepPartialEntity<T>)
    .where('id = :id', { id })
    .andWhere('NOT (CAST(:userId AS text) = ANY("ownerUserIds"))', { userId })
    .execute();
  return (result.affected ?? 0) > 0;
}

export async function removeChannelOwner<T extends OwnedChannel>(repo: Repository<T>, id: string, userId: string): Promise<void> {
  await repo
    .createQueryBuilder()
    .update()
    .set({ ownerUserIds: () => 'array_remove("ownerUserIds", CAST(:userId AS text))' } as QueryDeepPartialEntity<T>)
    .where('id = :id', { id, userId })
    .execute();
}

/** خطای unique constraint پستگرس (مثلاً identifier تکراری در insert هم‌زمان). */
export function isUniqueViolation(error: unknown): boolean {
  return error instanceof QueryFailedError && (error as QueryFailedError & { code?: string }).code === '23505';
}
