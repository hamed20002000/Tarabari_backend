import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { DataSource, Repository, IsNull, LessThanOrEqual, In, Not } from 'typeorm';
import { Cron } from '@nestjs/schedule';
import makeWASocket, {
  DisconnectReason,
  WASocket,
  WAMessage,
  fetchLatestBaileysVersion,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import * as qrcode from 'qrcode-terminal';
import { WhatsappAuthCredential } from '../entities/WhatsappAuthCredential';
import { WhatsappAuthKey } from '../entities/WhatsappAuthKey';
import { WhatsappChannelMessage } from '../entities/WhatsappChannelMessage';
import { OutboxEvent } from '../entities/OutboxEvent';
import { MonitoredChannel } from '../entities/MonitoredChannel';
import { MonitoredChatType, MonitoredChannelRole } from '../types';
import { useDbAuthState } from '../hooks/useDbAuthState';
import { TransportOrderService, CargoOrderExtraction } from '../services/aiTools.service';

const DEFAULT_SESSION_ID = 'main';
const CHANNEL_REPLACEMENT_NUMBER = '09394113259'; // بهتره از config/env بیاد

// شماره‌ی شخصی که علاوه بر گروه/کانال‌های مقصد، پیام‌های پردازش‌شده
// (سفارش‌های بار تشخیص‌داده‌شده) مستقیماً بهش هم فرستاده می‌شن. از .env
// خونده می‌شه -- اگه خالی باشه، این قابلیت به‌سادگی غیرفعال می‌مونه.
const PERSONAL_NOTIFY_NUMBER = process.env.WHATSAPP_PERSONAL_NOTIFY_NUMBER || '';

@Injectable()
export class WhatsappService implements OnModuleInit {
  private readonly logger = new Logger(WhatsappService.name);
  private sock: WASocket | null = null;

  // صف پیام‌های گروه/کانال که هنوز پردازش نشدن -- جلوگیری از فرستادن
  // چند درخواست هم‌زمان به Ollama که باعث timeout می‌شد.
  private channelMessageQueue: WAMessage[] = [];
  private isProcessingChannelQueue = false;

  // فاصله بین درخواست‌های فالو/جوین پشت‌سرهم -- جلوگیری از الگوی burst
  // مشکوک وقتی چند گروه/کانال هم‌زمان در دیتابیس اضافه شدن.
  private static readonly FOLLOW_DELAY_MS = 15000; // ۱۵ ثانیه

  // پارامترهای exponential backoff برای تلاش مجدد بعد از شکست.
  private static readonly BACKOFF_BASE_MINUTES = 5;
  private static readonly BACKOFF_MAX_MINUTES = 60;

  // بعد از اتصال، اگه PERSONAL_NOTIFY_NUMBER تنظیم شده باشه، JID
  // تاییدشده‌اش اینجا کش می‌شه.
  private personalNotifyJid: string | null = null;

  constructor(
    @InjectRepository(WhatsappAuthCredential)
    private readonly credentialRepo: Repository<WhatsappAuthCredential>,
    @InjectRepository(WhatsappAuthKey)
    private readonly keyRepo: Repository<WhatsappAuthKey>,
    @InjectRepository(WhatsappChannelMessage)
    private readonly channelMessageRepo: Repository<WhatsappChannelMessage>,
    @InjectRepository(MonitoredChannel)
    private readonly monitoredChannelRepo: Repository<MonitoredChannel>,
    // NEW: برای نوشتن اتمیک رکورد پیام + رکورد outbox در یه تراکنش واحد
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly transportOrderService: TransportOrderService,
  ) { }

  async onModuleInit() {
    await this.connect();
  }

  private async connect(): Promise<void> {
    const { state, saveCreds } = await useDbAuthState(
      DEFAULT_SESSION_ID,
      this.credentialRepo,
      this.keyRepo,
    );

    const { version, isLatest } = await fetchLatestBaileysVersion();
    this.logger.log(`Baileys sürümü: ${version.join('.')}, güncel mi: ${isLatest}`);

    this.sock = makeWASocket({
      auth: state,
      version,
      printQRInTerminal: false,
    });

    this.sock.ev.on('creds.update', saveCreds);

    this.sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        qrcode.generate(qr, { small: true });
      }

      if (connection === 'close') {
        const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        this.logger.warn(`WhatsApp bağlantısı kesildi. Yeniden bağlanılacak mı: ${shouldReconnect}`);

        if (shouldReconnect) {
          this.connect();
        } else {
          this.logger.error('Oturum kapatıldı (loggedOut). Yeni QR gerekiyor.');
        }
      } else if (connection === 'open') {
        this.logger.log('WhatsApp bağlantısı kuruldu.');
        void this.sock.updateProfileName('باربری تارابری').catch((err) =>
          this.logger.error('پروفایل نیم تنظیم نشد', err),
        );

        if (PERSONAL_NOTIFY_NUMBER) {
          this.resolvePersonalContact(PERSONAL_NOTIFY_NUMBER)
            .then((jid) => {
              this.personalNotifyJid = jid;
              this.logger.log(`Kişisel bildirim numarası doğrulandı: ${jid}`);
            })
            .catch((err) =>
              this.logger.error('Kişisel bildirim numarası doğrulanamadı', err as Error),
            );
        }

        void this.syncMonitoredChannels();
      }
    });

    this.sock.ev.on('group-participants.update', async (update) => {
      const { id: groupJid, participants, action } = update;

      if (action !== 'remove') return;

      const myJid = this.sock?.user?.id;
      if (!myJid) return;

      const normalizedMyJid = myJid.split(':')[0];
      const wasRemoved = participants.some(
        (p) => p.id.split(':')[0] === normalizedMyJid,
      );

      if (!wasRemoved) return;

      this.logger.warn(`🚫 Bot gruptan çıkarıldı: ${groupJid}`);

      await this.monitoredChannelRepo.update(
        { resolvedJid: groupJid },
        {
          isActive: false,
          isFollowed: false,
          lastError: 'Bot gruptan çıkarıldı (kicked/removed).',
        },
      );
    });

    this.sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;

      for (const msg of messages) {
        if (!msg.message) continue;

        const remoteJid = msg.key.remoteJid;

        if (remoteJid?.endsWith('@newsletter') || remoteJid?.endsWith('@g.us')) {
          this.enqueueChannelMessage(msg);
          continue;
        }
      }
    });
  }

  // ------------------------------------------------------------------
  // مدیریت گروه‌ها و کانال‌های مانیتور شده -- خوانده‌شده از دیتابیس
  // ------------------------------------------------------------------

  @Cron('*/2 * * * *')
  async syncMonitoredChannels(): Promise<void> {
    if (!this.sock) return;

    const pendingChannels = await this.monitoredChannelRepo.find({
      where: [
        { isActive: true, isFollowed: false, nextAttemptAt: IsNull() },
        { isActive: true, isFollowed: false, nextAttemptAt: LessThanOrEqual(new Date()) },
      ],
    });

    if (pendingChannels.length === 0) return;

    this.logger.log(`${pendingChannels.length} yeni grup/kanal bulundu, işleniyor...`);

    for (const channel of pendingChannels) {
      try {
        const resolvedJid =
          channel.type === MonitoredChatType.GROUP
            ? await this.joinGroup(channel.identifier)
            : await this.followChannel(channel.identifier);

        channel.resolvedJid = resolvedJid;
        channel.isFollowed = true;
        channel.lastError = null;
        channel.retryCount = 0;
        channel.nextAttemptAt = null;
        await this.monitoredChannelRepo.save(channel);

        this.logger.log(
          `${channel.type === MonitoredChatType.GROUP ? 'Gruba katılındı' : 'Kanal takip edildi'}: ${resolvedJid} (${channel.label ?? channel.identifier})`,
        );

        await new Promise((resolve) =>
          setTimeout(resolve, WhatsappService.FOLLOW_DELAY_MS),
        );
      } catch (error) {
        channel.lastError = (error as Error).message;
        channel.retryCount += 1;

        const backoffMinutes = Math.min(
          WhatsappService.BACKOFF_BASE_MINUTES * Math.pow(2, channel.retryCount - 1),
          WhatsappService.BACKOFF_MAX_MINUTES,
        );
        channel.nextAttemptAt = new Date(Date.now() + backoffMinutes * 60 * 1000);

        await this.monitoredChannelRepo.save(channel);

        this.logger.error(
          `İşlenemedi (${channel.type}): ${channel.identifier} -- ${backoffMinutes} dakika sonra tekrar denenecek (deneme #${channel.retryCount})`,
          error as Error,
        );
      }
    }
  }

  private isLikelyMobileNumber(rawNumber: string): boolean {
    const normalized = rawNumber
      .replace(/[۰-۹]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d).toString())
      .replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d).toString())
      .replace(/\D/g, '');

    let core = normalized;
    if (core.startsWith('98')) {
      core = core.slice(2);
    } else if (core.startsWith('0')) {
      core = core.slice(1);
    }

    return core.length === 10 && core.startsWith('9');
  }

  private async resolvePersonalContact(identifier: string): Promise<string> {
    if (!this.sock) throw new Error('WhatsApp soketi hazır değil.');

    if (identifier.endsWith('@s.whatsapp.net')) {
      return identifier;
    }

    let digits = identifier
      .replace(/[۰-۹]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d).toString())
      .replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d).toString())
      .replace(/\D/g, '');

    if (digits.startsWith('0')) {
      digits = '98' + digits.slice(1);
    } else if (!digits.startsWith('98')) {
      digits = '98' + digits;
    }

    const results = await this.sock.onWhatsApp(digits);
    if (!results || results.length === 0 || !results[0].exists) {
      throw new Error(`Numara WhatsApp'ta kayıtlı değil: ${identifier}`);
    }

    return results[0].jid ?? `${digits}@s.whatsapp.net`;
  }

  private async followChannel(identifier: string): Promise<string> {
    if (!this.sock) throw new Error('WhatsApp soketi hazır değil.');

    const metadata = identifier.endsWith('@newsletter')
      ? { id: identifier }
      : await this.sock.newsletterMetadata('invite', identifier);

    await this.sock.newsletterFollow(metadata.id);
    return metadata.id;
  }

  private async joinGroup(identifier: string): Promise<string> {
    if (!this.sock) throw new Error('WhatsApp soketi hazır değil.');

    if (identifier.endsWith('@g.us')) {
      return identifier;
    }

    try {
      const result = await this.sock.groupAcceptInvite(identifier);

      if (!result || typeof result !== 'string') {
        throw new Error(
          'Gruba katılım isteği gönderildi fakat onay bekliyor olabilir (Admin Approval açık olabilir).',
        );
      }

      return result;
    } catch (error) {
      this.logger.error(
        `groupAcceptInvite ham hata detayı: ${JSON.stringify(error, Object.getOwnPropertyNames(error as object))}`,
      );

      throw new Error(
        `Gruba katılınamadı (muhtemelen Admin Approval açık): ${(error as Error).message}`,
      );
    }
  }

  private enqueueChannelMessage(msg: WAMessage): void {
    this.channelMessageQueue.push(msg);
    void this.processChannelQueue();
  }

  private async processChannelQueue(): Promise<void> {
    if (this.isProcessingChannelQueue) return;
    this.isProcessingChannelQueue = true;

    try {
      while (this.channelMessageQueue.length > 0) {
        const msg = this.channelMessageQueue.shift()!;
        try {
          await this.handleChannelMessage(msg);
        } catch (error) {
          this.logger.error(
            `Kanal/grup mesajı işlenirken hata: ${msg.key.remoteJid}`,
            error as Error,
          );
        }
      }
    } finally {
      this.isProcessingChannelQueue = false;
    }
  }

  private buildProcessedText(
    data: CargoOrderExtraction,
    replacementNumber: string,
    orderCode?: string,
  ): string {
    if (!data.is_cargo_order) {
      return '';
    }

    const lines: string[] = [];

    if (data.cargo_type) {
      lines.push(`بار: ${data.cargo_type}`);
    }

    if (data.origin && data.destination) {
      lines.push(`مسیر: ${data.origin} به ${data.destination}`);
    } else if (data.origin) {
      lines.push(`مبدا: ${data.origin}`);
    } else if (data.destination) {
      lines.push(`مقصد: ${data.destination}`);
    }

    if (data.weight) {
      lines.push(`وزن: ${data.weight}`);
    }

    if (data.vehicle_type) {
      lines.push(`نوع خودرو: ${data.vehicle_type}`);
    }

    if (data.price) {
      lines.push(`قیمت: ${data.price}`);
    }

    const phoneRelatedPattern = /تلفن|تماس|شماره/;
    if (data.extra_notes && !phoneRelatedPattern.test(data.extra_notes)) {
      lines.push(data.extra_notes);
    }

    lines.push('');
    lines.push(`شماره تماس: ${replacementNumber}`);

    if (orderCode) {
      lines.push(`کد پیگیری: ${orderCode}`);
    }

    return lines.join('\n');
  }

  /**
   * پردازش کامل یک پیام جدید از گروه یا کانال: استخراج متن، تشخیص سفارش
   * بار، ذخیره در دیتابیس، و برای سفارش بار -- انتشار یه event
   * (cargo.message.detected) از طریق Outbox Pattern برای توزیع‌کننده.
   */
  private async handleChannelMessage(msg: WAMessage): Promise<void> {
    const channelJid = msg.key.remoteJid!;
    const messageId = msg.key.id;

    if (!messageId) return;

    const existing = await this.channelMessageRepo.findOne({ where: { messageId } });
    if (existing) return;

    const text =
      msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';

    if (!text) return;

    this.logger.log(`📩 Yeni mesaj [${channelJid}]: ${text.slice(0, 80)}...`);

    const record = this.channelMessageRepo.create({
      channelJid,
      messageId,
      rawText: text,
    });
    await this.channelMessageRepo.save(record);

    try {
      const startedAt = Date.now();
      this.logger.log(
        `⏱️ Model çağrısı başlıyor [${channelJid}] [${messageId}] -- kuyrukta bekleyen: ${this.channelMessageQueue.length}`,
      );

      const extraction = await this.transportOrderService.DetermineTextIsTransportOrder(
        text,
        CHANNEL_REPLACEMENT_NUMBER,
      );

      const elapsedMs = Date.now() - startedAt;
      this.logger.log(
        `⏱️ Model çağrısı bitti [${channelJid}] [${messageId}] -- ${elapsedMs}ms sürdü`,
      );

      record.isCargoOrder = extraction.is_cargo_order;
      record.confidence = extraction.confidence;
      record.foundPhoneNumbers = extraction.found_phone_numbers;

      // فعلاً غیرفعال -- در این مرحله به صاحب بار/شماره‌های داخل پیام چیزی
      // فرستاده نمی‌شه. بعداً با متن واقعی جایگزین می‌شه.
      // if (extraction.found_phone_numbers && extraction.found_phone_numbers.length > 0) {
        // for (const rawNumber of extraction.found_phone_numbers) {
          // if (!this.isLikelyMobileNumber(rawNumber)) {
            // this.logger.log(`⏭️ Sabit hat olduğu için atlandı: ${rawNumber}`);
            // continue;
          // }

          // try {
            // const customerJid = await this.resolvePersonalContact(rawNumber);
            // await this.sendMessage(customerJid, 'این یک پیام تستی از سیستم است.');
            // this.logger.log(
              // `📤 Test mesajı gönderildi: ${rawNumber} -> ${customerJid}`,
            // );
          // } catch (testError) {
            // this.logger.error(
              // `Test mesajı gönderilemedi: ${rawNumber}`,
              // testError as Error,
            // );
          // }
        // }
      // }

      if (extraction.is_cargo_order) {
        const processedText = this.buildProcessedText(
          extraction,
          CHANNEL_REPLACEMENT_NUMBER,
        );

        // ذخیره‌ی رکورد پیام + ثبت رکورد outbox در یه تراکنش واحد -- یا هر
        // دو انجام می‌شن یا هیچ‌کدوم. match کردن با تنظیمات subscriberها کار
        // توزیع‌کننده (برنامه‌ی دیگه) هست که این event رو مصرف می‌کنه.
        await this.dataSource.transaction(async (manager) => {
          await manager.save(WhatsappChannelMessage, record);

          await manager.insert(OutboxEvent, {
            eventType: 'cargo.message.detected',
            payload: {
              messageId: record.id,
              channelJid,
              rawText: text,
              receivedAt: record.receivedAt,
              origin: extraction.origin,
              destination: extraction.destination,
              cargoType: extraction.cargo_type,
              weight: extraction.weight,
              vehicleType: extraction.vehicle_type,
              price: extraction.price,
              extraNotes: extraction.extra_notes,
              processedText,
            },
          });
        });

        this.logger.log(`✅ Kargo siparişi tespit edildi [${channelJid}] [${record.id}]`);

        // if (this.personalNotifyJid) {
        //   try {
        //     await this.sendMessage(this.personalNotifyJid, text);
        //     this.logger.log(
        //       `📤 Kişisel bildirim gönderildi: [${channelJid}] -> [${this.personalNotifyJid}]`,
        //     );
        //   } catch (personalError) {
        //     this.logger.error(
        //       `Kişisel bildirim gönderilemedi: [${channelJid}] -> [${this.personalNotifyJid}]`,
        //       personalError as Error,
        //     );
        //   }
        // }
      } else {
        await this.channelMessageRepo.save(record);
      }
    } catch (error) {
      this.logger.error(`Mesaj analiz edilemedi: ${messageId}`, error as Error);
    }
  }

  private async forwardToAllDestinations(
    text: string,
    sourceJid: string,
  ): Promise<void> {
    const destinations = await this.monitoredChannelRepo.find({
      where: {
        isActive: true,
        role: In([MonitoredChannelRole.DESTINATION, MonitoredChannelRole.BOTH]),
        resolvedJid: Not(IsNull()),
      },
    });

    if (destinations.length === 0) return;

    for (const destination of destinations) {
      if (!destination.resolvedJid) continue;
      if (destination.resolvedJid === sourceJid) continue;

      try {
        await this.sendMessage(destination.resolvedJid, text);
        this.logger.log(
          `📤 Mesaj iletildi: [${sourceJid}] -> [${destination.resolvedJid}] (${destination.label ?? destination.identifier})`,
        );
        await new Promise((resolve) => setTimeout(resolve, 1000));
      } catch (forwardError) {
        this.logger.error(
          `Mesaj iletilemedi: [${sourceJid}] -> [${destination.resolvedJid}]`,
          forwardError as Error,
        );
      }
    }
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.sock) {
      this.logger.error('WhatsApp soketi hazır değil.');
      return;
    }

    const SEND_TIMEOUT_MS = 15000;

    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`sendMessage zaman aşımı: ${jid}`)), SEND_TIMEOUT_MS);
    });

    try {
      await Promise.race([this.sock.sendMessage(jid, { text }), timeoutPromise]);
    } catch (error) {
      this.logger.error(`sendMessage başarısız: ${jid}`, error as Error);
    }
  }
}