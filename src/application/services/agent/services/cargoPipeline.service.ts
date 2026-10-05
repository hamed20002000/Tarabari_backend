import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, DeepPartial, EntityManager, EntityTarget, ObjectLiteral } from 'typeorm';
import { OutboxEvent } from '../entities/OutboxEvent';
import { TransportOrderService, CargoOrderExtraction } from './aiTools.service';
import { buildCargoProcessedText } from '../common/cargoText';

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

  constructor(
    private readonly transportOrderService: TransportOrderService,
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) { }

  /** نتیجه‌ی مدل رو برمی‌گردونه (بار یا غیربار)، یا null اگه پردازش خطا داد. */
  async process<T extends CargoMessageRecord>(
    candidate: CargoCandidate<T>,
  ): Promise<CargoOrderExtraction | null> {
    const { label, text, isVoice } = candidate;

    this.logger.log(`📩 ${isVoice ? 'پیام صوتی' : 'پیام'} جدید [${label}]: ${text.slice(0, 80)}...`);

    try {
      const startedAt = Date.now();
      this.logger.log(
        `⏱️ فراخوانی مدل شروع شد [${label}] -- در صف مدل: ${this.transportOrderService.pendingCount}`,
      );

      const extraction = await this.transportOrderService.DetermineTextIsTransportOrder(text);

      this.logger.log(`⏱️ فراخوانی مدل تموم شد [${label}] -- ${Date.now() - startedAt}ms طول کشید`);

      // پیام‌های غیربار ذخیره نمی‌شن -- فقط سفارش‌های بار وارد دیتابیس می‌شن.
      if (extraction.is_cargo_order) {
        await this.saveCargo(candidate, extraction);
      }

      return extraction;
    } catch (error) {
      this.logger.error(`تحلیل پیام ناموفق بود [${label}]`, error as Error);
      return null;
    }
  }

  private async saveCargo<T extends CargoMessageRecord>(
    { label, text, isVoice, entity, record, source, ownerUserIds }: CargoCandidate<T>,
    extraction: CargoOrderExtraction,
  ): Promise<void> {
    // ذخیره‌ی رکوردهای بار + ثبت رکوردهای outbox در یه تراکنش واحد -- یا همه
    // انجام می‌شن یا هیچ‌کدوم. match کردن با تنظیمات subscriberها کار
    // توزیع‌کننده (برنامه‌ی دیگه) هست که این event رو مصرف می‌کنه.
    // هر بارِ پیام (یک مسیر مستقل) رکورد، کد پیگیری و event خودش رو داره --
    // توزیع‌کننده هر event رو با messageId (شناسه‌ی همین رکورد) یک بار جدا حساب می‌کنه.
    const codes = await this.dataSource.transaction(async (manager) => {
      const saved: string[] = [];

      for (const [cargoIndex, load] of extraction.loads.entries()) {
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
