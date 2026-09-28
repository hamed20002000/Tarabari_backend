import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * ستون‌های زمانی بدون منطقه‌ی زمانی (timestamp) به timestamptz تبدیل می‌شن.
 * قبلاً Postgres زمان now() رو به وقت Europe/Istanbul می‌نوشت ولی Node همون
 * عدد رو به وقت Asia/Tehran می‌خوند -- ۳۰ دقیقه اختلاف. هر ستون با منطقه‌ی
 * زمانی‌ای که واقعاً باهاش نوشته شده تفسیر می‌شه:
 *   - پیش‌فرض now() / CreateDateColumn / UpdateDateColumn -> Europe/Istanbul (TimeZone سرور Postgres)
 *   - مقدارهایی که Node (با new Date()) می‌نوشت -> Asia/Tehran (TZ پروسه‌ی Node)
 */
const DB_WRITTEN: Array<[string, string]> = [
    ['WhatsappAuthCredential', 'updatedAt'],
    ['WhatsappAuthKey', 'updatedAt'],
    ['candidate_listing', 'createdAt'],
    ['cargo_subscription', 'createdAt'],
    ['cargo_subscription', 'updatedAt'],
    ['monitored_channel', 'createdAt'],
    ['outbox_event', 'createdAt'],
    ['telegram_channel_message', 'receivedAt'],
    ['telegram_monitored_channel', 'createdAt'],
    ['telegram_user_session', 'updatedAt'],
    ['whatsapp_channel_message', 'receivedAt'],
];

const NODE_WRITTEN: Array<[string, string]> = [
    ['candidate_listing', 'selectedAt'],
    ['monitored_channel', 'nextAttemptAt'],
    ['telegram_monitored_channel', 'joinedAt'],
    ['telegram_monitored_channel', 'lastJoinAttemptAt'],
    ['telegram_monitored_channel', 'nextAttemptAt'],
];

const COLUMNS: Array<[string, string, string]> = [
    ...DB_WRITTEN.map(([table, column]): [string, string, string] => [table, column, 'Europe/Istanbul']),
    ...NODE_WRITTEN.map(([table, column]): [string, string, string] => [table, column, 'Asia/Tehran']),
];

export class TimestampWithTimeZone1791200000000 implements MigrationInterface {
    name = 'TimestampWithTimeZone1791200000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        for (const [table, column, zone] of COLUMNS) {
            await queryRunner.query(
                `ALTER TABLE "${table}" ALTER COLUMN "${column}" TYPE TIMESTAMP WITH TIME ZONE USING "${column}" AT TIME ZONE '${zone}'`,
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        for (const [table, column, zone] of COLUMNS) {
            await queryRunner.query(
                `ALTER TABLE "${table}" ALTER COLUMN "${column}" TYPE TIMESTAMP WITHOUT TIME ZONE USING "${column}" AT TIME ZONE '${zone}'`,
            );
        }
    }

}
