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
  /** entity پیام‌های بار همون پلتفرم (WhatsappChannelMessage یا TelegramChannelMessage). */
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
  code: string;
  receivedAt: Date;
}

/**
 * خط لوله‌ی مشترک تشخیص بار برای واتساپ و تلگرام: فراخوانی مدل، و فقط برای
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
    // ذخیره‌ی رکورد پیام + ثبت رکورد outbox در یه تراکنش واحد -- یا هر دو
    // انجام می‌شن یا هیچ‌کدوم. match کردن با تنظیمات subscriberها کار
    // توزیع‌کننده (برنامه‌ی دیگه) هست که این event رو مصرف می‌کنه.
    const saved = await this.dataSource.transaction(async (manager) => {
      const code = await this.nextCargoCode(manager);
      const processedText = buildCargoProcessedText(extraction, code);

      const message = await manager.save(
        entity,
        manager.create(entity, {
          ...record,
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
          origin: extraction.origin,
          destination: extraction.destination,
          cargoType: extraction.cargo_type,
          weight: extraction.weight,
          vehicleType: extraction.vehicle_type,
          price: extraction.price,
          extraNotes: extraction.extra_notes,
          processedText,
          ownerUserIds,
        },
      });

      return message;
    });

    this.logger.log(`✅ سفارش بار تشخیص داده شد [${label}] [${saved.code}]`);
  }

  /** کد پیگیری بعدی: TRB + عدد sequence مشترک بین واتساپ و تلگرام. */
  private async nextCargoCode(manager: EntityManager): Promise<string> {
    const [{ value }] = await manager.query(`SELECT nextval('cargo_code_seq') AS value`);
    return `TRB${value}`;
  }
}
