import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, DeepPartial, EntityManager, EntityTarget, ObjectLiteral } from 'typeorm';
import { OutboxEvent } from '../entities/OutboxEvent';
import { PendingCargoMessage } from '../entities/PendingCargoMessage';
import { LlmUnavailableError } from '../common/llmClient';
import { TransportOrderService, CargoOrderExtraction, CargoLoad } from './aiTools.service';
import { SpeechToTextService } from './speechToText.service';
import { buildCargoProcessedText } from '../common/cargoText';
import { cargoLineHashes, cargoLoadHash, cargoTextHash } from '../utils/persianText';
import { snapPlaceName } from '../utils/placeNames';

// متن تکراری تا این مدت (ساعت) دوباره پردازش و ارسال نمی‌شه.
const DUPLICATE_WINDOW_HOURS = Number(process.env.CARGO_DUPLICATE_WINDOW_HOURS) || 24;
// پیامی که چون مدل در دسترس نبود پردازش نشد، تا این مدت (ساعت) دوباره امتحان می‌شه؛ بعدش بار کهنه‌ست.
const RETRY_MAX_HOURS = Number(process.env.CARGO_RETRY_MAX_HOURS) || 6;
// هر دقیقه حداکثر این تعداد پیام از صف تلاش دوباره
const RETRY_BATCH = 20;
const MINUTE_MS = 60_000;

export interface CargoCandidate<T extends CargoMessageRecord> {
  /** برای لاگ‌ها، مثلاً شناسه‌ی گروه/کانال. */
  label: string;
  text: string;
  isVoice: boolean;
  /** entity پیام‌های بار همون پلتفرم (WhatsappChannelMessage، TelegramChannelMessage و ...). */
  entity: EntityTarget<T>;
  /** فیلدهای مخصوص پلتفرم برای رکورد پیام (شناسه‌ی چت/پیام و ...). */
  record: DeepPartial<T>;
  /** فیلدهای مخصوص پلتفرم که به payload رویداد outbox اضافه می‌شن. */
  source: Record<string, unknown>;
  /**
   * شناسه‌ی کاربرهای transport_backend که گروه/کانال مبدا رو ثبت کردن --
   * اعلان و نمایش این بار فقط برای همین کاربرهاست.
   */
  ownerUserIds: string[];
  /** پردازش دوباره از صف (retryPending): خطا به صف برمی‌گرده، نه دوباره به صف اضافه بشه */
  retry?: boolean;
}


export interface CargoMessageRecord extends ObjectLiteral {
  id: string;
  /** ترتیب بار داخل پیام (۰ برای اولین) -- یک پیام ممکنه چند بار داشته باشه. */
  cargoIndex: number;
  code: string;
  receivedAt: Date;
}

/**
 * خط لوله‌ی مشترک تشخیص بار برای همه‌ی پلتفرم‌ها: فراخوانی مدل، و فقط برای
 * سفارش بار -- ذخیره‌ی رکورد پیام + ثبت رویداد cargo.message.detected در یک
 * تراکنش واحد (Outbox Pattern) تا توزیع‌کننده مصرفش کنه.
 */
@Injectable()
export class CargoPipelineService {
  private readonly logger = new Logger(CargoPipelineService.name);
  private retrying = false;

  constructor(
    private readonly transportOrderService: TransportOrderService,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly speech: SpeechToTextService,
  ) { }

  /** نتیجه‌ی مدل رو برمی‌گردونه (بار یا غیربار)، یا null اگه پردازش خطا داد. */
  async process<T extends CargoMessageRecord>(
    candidate: CargoCandidate<T>,
  ): Promise<CargoOrderExtraction | null> {
    const { label, text, isVoice } = candidate;

    this.logger.log(`📩 ${isVoice ? 'پیام صوتی' : 'پیام'} جدید [${label}]: ${text.slice(0, 80)}...`);

    // همون آگهی که دوباره پست شده (یا در گروه/پلتفرم دیگه‌ای پخش شده) شناسه‌ی
    // پیام جدید داره -- فقط ثبت‌کننده‌هایی که این متن رو هنوز نگرفتن می‌مونن.
    const contentHash = cargoTextHash(text);
    const ownerUserIds = await this.claimOwners(contentHash, candidate.ownerUserIds);
    if (ownerUserIds.length === 0) {
      this.logger.log(`⏭️ پیام تکراری رد شد [${label}]`);
      return null;
    }

    // لیست تقریباً تکراری (همه‌ی خط‌هایش را این ثبت‌کننده در بازه‌ی تکرار گرفته؛ فقط ساعت/
    // جداکننده/ایموجی فرق دارد) به مدل نمی‌رود. یک خط تازه (مثلاً بار جدید در لیست) کافی است
    // تا پیام پردازش شود؛ بارهای قبلی‌اش را بعداً تکرار بار رد می‌کند.
    const lineHashes = cargoLineHashes(text);
    const seenAll = new Set(await this.ownersWhoSawAllLines(lineHashes, ownerUserIds));
    const freshOwners = ownerUserIds.filter((userId) => !seenAll.has(userId));
    if (freshOwners.length === 0) {
      this.logger.log(`⏭️ لیست تقریباً تکراری رد شد (بدون خط تازه) [${label}]`);
      return null;
    }
    candidate = { ...candidate, ownerUserIds: freshOwners };

    // بارهایی که این پیام رزرو کرد؛ اگر پردازش خطا داد آزاد می‌شوند تا تکرار بعدی از دست نرود
    let claimedLoads: { hash: string; ownerUserIds: string[] }[] = [];
    try {
      const startedAt = Date.now();
      this.logger.log(
        `⏱️ فراخوانی مدل شروع شد [${label}] -- در صف مدل: ${this.transportOrderService.pendingCount}`,
      );

      const detected = await this.transportOrderService.DetermineTextIsTransportOrder(text);
      const extraction = isVoice ? this.snapVoicePlaces(detected, label) : detected;

      this.logger.log(`⏱️ فراخوانی مدل تموم شد [${label}] -- ${Date.now() - startedAt}ms طول کشید`);

      // پیام‌های غیربار ذخیره نمی‌شن -- فقط سفارش‌های بار وارد دیتابیس می‌شن.
      if (extraction.is_cargo_order) {
        const loads = await this.freshLoads(extraction, freshOwners, label);
        claimedLoads = loads;
        if (loads.length) await this.saveCargo(candidate, extraction, loads);
      }

      // بعد از ذخیره‌ی موفق: خط‌های پیام «دیده‌شده» تا تکرار تقریبی بعدی به مدل نرود (بار یا غیربار).
      await this.markSeen(lineHashes, freshOwners);

      return extraction;
    } catch (error) {
      this.logger.error(`تحلیل پیام ناموفق بود [${label}]`, error as Error);
      // پردازش نشد -- پست بعدی همین متن (و بارهایش) نباید تکراری حساب بشه.
      await this.releaseOwners([contentHash], ownerUserIds).catch(() => undefined);
      for (const load of claimedLoads) await this.releaseOwners([load.hash], load.ownerUserIds).catch(() => undefined);
      if (candidate.retry) throw error;
      // مدل در دسترس نبود (OpenAI یا VPN قطع): پیام نگه داشته می‌شه تا دوباره امتحان بشه
      if (error instanceof LlmUnavailableError) await this.enqueueRetry(candidate);
      return null;
    }
  }

  //#region --------------------  صف تلاش دوباره: پیام‌هایی که وقتی مدل در دسترس نبود پردازش نشدن --------------

  /** پیام صوتی که مدل نتونست به متن تبدیلش کنه (VoiceTranscript.unheard): با خود صدا در صف می‌مونه. */
  async queueVoice<T extends CargoMessageRecord>(candidate: Omit<CargoCandidate<T>, 'text' | 'isVoice'>, audio: Buffer): Promise<void> {
    await this.enqueueRetry({ ...candidate, text: '', isVoice: true }, audio);
  }

  private async enqueueRetry<T extends CargoMessageRecord>(candidate: CargoCandidate<T>, audio: Buffer | null = null): Promise<void> {
    const { label, text, isVoice, entity, record, source, ownerUserIds } = candidate;
    try {
      await this.dataSource.getRepository(PendingCargoMessage).save({
        label,
        text,
        audio,
        isVoice,
        entityName: this.dataSource.getMetadata(entity).name,
        record: record as Record<string, unknown>,
        source,
        ownerUserIds,
        nextAttemptAt: new Date(Date.now() + MINUTE_MS),
      });
      this.logger.warn(`⏳ مدل در دسترس نیست؛ پیام برای تلاش دوباره نگه داشته شد [${label}]`);
    } catch (error) {
      this.logger.error(`نگه داشتن پیام برای تلاش دوباره ناموفق بود [${label}]`, error as Error);
    }
  }

  /**
   * پیام‌های موعدرسیده‌ی صف، قدیمی‌ترین اول. موفق یا تکراری: از صف برداشته می‌شه. باز هم مدل در دسترس نبود: بقیه‌ی
   * صف این دقیقه امتحان نمی‌شه و هر پیام دیرتر (۱، ۲، ۴ … تا ۳۰ دقیقه) دوباره امتحان می‌شه. کهنه‌تر از
   * RETRY_MAX_HOURS: کنار گذاشته می‌شه. پیام صوتی اول به متن تبدیل می‌شه.
   */
  @Cron('* * * * *')
  async retryPending(): Promise<void> {
    if (this.retrying) return;
    this.retrying = true;
    const repo = this.dataSource.getRepository(PendingCargoMessage);
    try {
      const due = await repo
        .createQueryBuilder('p')
        .where('p."nextAttemptAt" <= now()')
        .orderBy('p."createdAt"', 'ASC')
        .limit(RETRY_BATCH)
        .getMany();
      for (const pending of due) {
        if (Date.now() - pending.createdAt.getTime() > RETRY_MAX_HOURS * 3_600_000) {
          await repo.delete({ id: pending.id });
          this.logger.warn(`🗑️ پیام بعد از ${pending.attempts} تلاش و ${RETRY_MAX_HOURS} ساعت کنار گذاشته شد [${pending.label}]`);
          continue;
        }
        try {
          // پیام صوتی هنوز تبدیل‌نشده: اول به متن، و متن نگه داشته می‌شه تا دوباره هزینه‌ی تبدیل نده
          if (pending.audio && !pending.text) {
            const text = await this.speech.transcribe(pending.audio, 'ogg');
            if (!text) {
              await repo.delete({ id: pending.id });
              this.logger.log(`🔇 پیام صوتی صف گفتاری نداشت [${pending.label}]`);
              continue;
            }
            await repo.update({ id: pending.id }, { text, audio: null });
            pending.text = text;
          }
          await this.process({
            label: pending.label,
            text: pending.text,
            isVoice: pending.isVoice,
            entity: this.dataSource.getMetadata(pending.entityName).target as EntityTarget<CargoMessageRecord>,
            record: pending.record as DeepPartial<CargoMessageRecord>,
            source: pending.source,
            ownerUserIds: pending.ownerUserIds,
            retry: true,
          });
          await repo.delete({ id: pending.id });
          this.logger.log(`✅ پیام صف بعد از ${pending.attempts + 1} تلاش پردازش شد [${pending.label}]`);
        } catch (error) {
          const attempts = pending.attempts + 1;
          await repo.update(
            { id: pending.id },
            {
              attempts,
              nextAttemptAt: new Date(Date.now() + Math.min(2 ** pending.attempts, 30) * MINUTE_MS),
              lastError: (error as Error).message.slice(0, 500),
            },
          );
          // هنوز قطع است: بقیه‌ی صف همین الان امتحان نمی‌شه
          if (error instanceof LlmUnavailableError) break;
        }
      }
    } catch (error) {
      this.logger.error('تلاش دوباره‌ی پیام‌های صف ناموفق بود', error as Error);
    } finally {
      this.retrying = false;
    }
  }

  //#endregion

  /**
   * whisper اسم شهرها رو گاهی آوایی و اشتباه می‌نویسه («تبیز»، «زایدان») --
   * مبدا/مقصد بارهای ویس به نزدیک‌ترین شهر/مرز شناخته‌شده اصلاح می‌شن.
   * (متن تایپ‌شده دست نمی‌خوره؛ اونجا املای کاربر معتبرتره.)
   */
  private snapVoicePlaces(extraction: CargoOrderExtraction, label: string): CargoOrderExtraction {
    const loads = extraction.loads.map((load) => {
      const origin = snapPlaceName(load.origin);
      const destination = snapPlaceName(load.destination);
      if (origin !== load.origin || destination !== load.destination) {
        this.logger.log(
          `🗺️ اصلاح اسم شهر در ویس [${label}]: ${load.origin} → ${origin}، ${load.destination} → ${destination}`,
        );
      }
      return { ...load, origin, destination };
    });
    return { ...extraction, loads };
  }

  /**
   * اتمیک: ثبت‌کننده‌هایی که این متن رو در DUPLICATE_WINDOW_HOURS گذشته
   * نگرفتن، برای این پیام رزرو می‌شن و برگردونده می‌شن (پلتفرم‌ها صف جدا
   * دارن و ممکنه هم‌زمان همون آگهی رو بفرستن). پیام غیربار هم رزرو می‌مونه
   * تا تکرارش دوباره به مدل نره.
   */
  private async claimOwners(contentHash: string, ownerUserIds: string[]): Promise<string[]> {
    if (ownerUserIds.length === 0) return [];
    const rows: { userId: string }[] = await this.dataSource.query(
      `INSERT INTO "cargo_text_fingerprint" ("contentHash", "userId", "seenAt")
       SELECT $1, u, now() FROM unnest($2::varchar[]) AS u
       ON CONFLICT ("contentHash", "userId") DO UPDATE SET "seenAt" = EXCLUDED."seenAt"
       WHERE "cargo_text_fingerprint"."seenAt" < now() - make_interval(hours => $3)
       RETURNING "userId"`,
      [contentHash, ownerUserIds, DUPLICATE_WINDOW_HOURS],
    );
    return rows.map((row) => row.userId);
  }

  private async releaseOwners(hashes: string[], ownerUserIds: string[]): Promise<void> {
    await this.dataSource.query(
      `DELETE FROM "cargo_text_fingerprint" WHERE "contentHash" = ANY($1::varchar[]) AND "userId" = ANY($2::varchar[])`,
      [hashes, ownerUserIds],
    );
  }

  /** ثبت‌کننده‌هایی که همه‌ی این خط‌ها را در بازه‌ی تکرار گرفته‌اند. */
  private async ownersWhoSawAllLines(lineHashes: string[], ownerUserIds: string[]): Promise<string[]> {
    if (lineHashes.length === 0) return [];
    const rows: { userId: string }[] = await this.dataSource.query(
      `SELECT "userId" FROM "cargo_text_fingerprint"
       WHERE "contentHash" = ANY($1::varchar[]) AND "userId" = ANY($2::varchar[])
         AND "seenAt" >= now() - make_interval(hours => $3)
       GROUP BY "userId" HAVING count(*) = $4`,
      [lineHashes, ownerUserIds, DUPLICATE_WINDOW_HOURS, lineHashes.length],
    );
    return rows.map((row) => row.userId);
  }

  private async markSeen(hashes: string[], ownerUserIds: string[]): Promise<void> {
    if (hashes.length === 0 || ownerUserIds.length === 0) return;
    await this.dataSource.query(
      `INSERT INTO "cargo_text_fingerprint" ("contentHash", "userId", "seenAt")
       SELECT h, u, now() FROM unnest($1::varchar[]) AS h, unnest($2::varchar[]) AS u
       ON CONFLICT ("contentHash", "userId") DO UPDATE SET "seenAt" = EXCLUDED."seenAt"`,
      [hashes, ownerUserIds],
    );
  }

  /**
   * هر بار فقط برای ثبت‌کننده‌هایی که همین بار (مبدا، مقصد، نوع، وزن، خودرو و شماره‌ی
   * تماس) را در بازه‌ی تکرار از متن دیگری نگرفته‌اند؛ باری که برای همه تکراری است حذف می‌شود.
   */
  private async freshLoads(
    extraction: CargoOrderExtraction,
    ownerUserIds: string[],
    label: string,
  ): Promise<{ load: CargoLoad; hash: string; ownerUserIds: string[] }[]> {
    const fresh: { load: CargoLoad; hash: string; ownerUserIds: string[] }[] = [];
    let skipped = 0;
    for (const load of extraction.loads) {
      const hash = cargoLoadHash(load, extraction.found_phone_numbers);
      const owners = await this.claimOwners(hash, ownerUserIds);
      if (owners.length) fresh.push({ load, hash, ownerUserIds: owners });
      else skipped++;
    }
    if (skipped) this.logger.log(`⏭️ ${skipped} بار تکراری از ${extraction.loads.length} بار رد شد [${label}]`);
    return fresh;
  }

  @Cron('23 * * * *')
  async purgeOldFingerprints(): Promise<void> {
    await this.dataSource
      .query(`DELETE FROM "cargo_text_fingerprint" WHERE "seenAt" < now() - make_interval(hours => $1)`, [
        DUPLICATE_WINDOW_HOURS,
      ])
      .catch((error) => this.logger.error('پاک‌سازی اثر انگشت پیام‌ها ناموفق بود', error as Error));
  }

  private async saveCargo<T extends CargoMessageRecord>(
    { label, text, isVoice, entity, record, source }: CargoCandidate<T>,
    extraction: CargoOrderExtraction,
    loads: { load: CargoLoad; ownerUserIds: string[] }[],
  ): Promise<void> {
    // ذخیره‌ی رکوردهای بار + ثبت رکوردهای outbox در یه تراکنش واحد -- یا همه
    // انجام می‌شن یا هیچ‌کدوم. match کردن با تنظیمات subscriberها کار
    // توزیع‌کننده (برنامه‌ی دیگه) هست که این event رو مصرف می‌کنه.
    // هر بارِ پیام (یک مسیر مستقل) رکورد، کد پیگیری و event خودش رو داره --
    // توزیع‌کننده هر event رو با messageId (شناسه‌ی همین رکورد) یک بار جدا حساب می‌کنه.
    const codes = await this.dataSource.transaction(async (manager) => {
      const saved: string[] = [];

      // cargoIndex همان جای بار در پیام می‌ماند (بارهای تکراری رد شده‌اند)
      for (const { load, ownerUserIds } of loads) {
        const cargoIndex = extraction.loads.indexOf(load);
        const code = await this.nextCargoCode(manager);
        const processedText = buildCargoProcessedText(load, code);

        const message = await manager.save(
          entity,
          manager.create(entity, {
            ...record,
            cargoIndex,
            code,
            rawText: text,
            confidence: extraction.confidence,
            foundPhoneNumbers: extraction.found_phone_numbers,
          } as DeepPartial<T>),
        );

        await manager.insert(OutboxEvent, {
          eventType: 'cargo.message.detected',
          payload: {
            ...source,
            messageId: message.id,
            code,
            isVoice,
            rawText: text,
            receivedAt: message.receivedAt,
            origin: load.origin,
            destination: load.destination,
            cargoType: load.cargo_type,
            weight: load.weight,
            vehicleType: load.vehicle_type,
            price: load.price,
            extraNotes: load.extra_notes,
            processedText,
            ownerUserIds,
          },
        });

        saved.push(code);
      }

      return saved;
    });

    this.logger.log(`✅ ${codes.length} بار تشخیص داده شد [${label}] [${codes.join(', ')}]`);
  }

  /** کد پیگیری بعدی: TRB + عدد sequence مشترک بین همه‌ی پلتفرم‌ها. */
  private async nextCargoCode(manager: EntityManager): Promise<string> {
    const [{ value }] = await manager.query(`SELECT nextval('cargo_code_seq') AS value`);
    return `TRB${value}`;
  }
}
