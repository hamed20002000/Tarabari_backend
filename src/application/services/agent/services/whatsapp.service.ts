import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, IsNull, LessThanOrEqual, In, Not } from 'typeorm';
import { Cron } from '@nestjs/schedule';
import makeWASocket, {
  DisconnectReason,
  WASocket,
  WAMessage,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import * as qrcode from 'qrcode-terminal';
import { WhatsappAuthCredential } from '../entities/WhatsappAuthCredential';
import { WhatsappAuthKey } from '../entities/WhatsappAuthKey';
import { WhatsappChannelMessage } from '../entities/WhatsappChannelMessage';
import { MonitoredChannel } from '../entities/MonitoredChannel';
import { ChannelMembershipStatus, MonitoredChatType, MonitoredChannelRole } from '../types';
import { ChannelMembershipService } from './channelMembership.service';
import { useDbAuthState } from '../hooks/useDbAuthState';
import { SpeechToTextService } from './speechToText.service';
import { CargoPipelineService } from './cargoPipeline.service';
import { SerialTaskQueue } from '../common/serialTaskQueue';
import { RecentIdCache } from '../common/recentIdCache';
import { exponentialBackoffMinutes } from '../common/backoff';
import { isChannelMonitoringEnabled } from '../common/channelMonitoring';

const DEFAULT_SESSION_ID = 'main';

// شماره‌ی شخصی که علاوه بر گروه/کانال‌های مقصد، پیام‌های پردازش‌شده
// (سفارش‌های بار تشخیص‌داده‌شده) مستقیماً بهش هم فرستاده می‌شن. از .env
// خونده می‌شه -- اگه خالی باشه، این قابلیت به‌سادگی غیرفعال می‌مونه.
const PERSONAL_NOTIFY_NUMBER = process.env.WHATSAPP_PERSONAL_NOTIFY_NUMBER || '';

// درخواست عضویت ثبت شده و منتظر تایید ادمین گروهه.
class WhatsappJoinPendingError extends Error { }
// خطایی که با تلاش دوباره درست نمی‌شه (لینک نامعتبر/باطل، بن شدن).
class WhatsappPermanentJoinError extends Error { }

// کدهای HTTP که Baileys (Boom) برای خطاهای دائمی عضویت برمی‌گردونه.
const PERMANENT_JOIN_STATUS: Record<number, string> = {
  400: 'لینک دعوت نامعتبره.',
  401: 'ربات اجازه‌ی عضویت در این گروه/کانال رو نداره (احتمالاً حذف یا بن شده).',
  403: 'ربات اجازه‌ی عضویت در این گروه/کانال رو نداره.',
  404: 'گروه/کانالی با این لینک پیدا نشد.',
  406: 'لینک دعوت نامعتبره.',
  410: 'لینک دعوت باطل یا منقضی شده.',
};

function toJoinError(error: unknown): Error {
  if (error instanceof WhatsappPermanentJoinError || error instanceof WhatsappJoinPendingError) return error;
  const status = (error as Boom)?.output?.statusCode;
  if (status && PERMANENT_JOIN_STATUS[status]) return new WhatsappPermanentJoinError(PERMANENT_JOIN_STATUS[status]);
  return new Error(`عضویت ناموفق بود: ${(error as Error)?.message ?? String(error)}`);
}

@Injectable()
export class WhatsappService implements OnModuleInit {
  private readonly logger = new Logger(WhatsappService.name);
  private sock: WASocket | null = null;

  // صف پیام‌های گروه/کانال که هنوز پردازش نشدن -- جلوگیری از فرستادن
  // چند درخواست هم‌زمان به Ollama که باعث timeout می‌شد.
  private readonly messageQueue = new SerialTaskQueue();

  // شناسه‌ی پیام‌هایی که اخیراً بررسی شدن -- چون فقط پیام‌های بار توی
  // دیتابیس ذخیره می‌شن، این کش جلوی فرستادن دوباره‌ی پیام‌های غیربارِ
  // تکراری (redelivery واتساپ) به مدل رو می‌گیره.
  private readonly recentMessageIds = new RecentIdCache(1000);

  // فاصله بین درخواست‌های فالو/جوین پشت‌سرهم -- جلوگیری از الگوی burst
  // مشکوک وقتی چند گروه/کانال هم‌زمان در دیتابیس اضافه شدن.
  private static readonly FOLLOW_DELAY_MS = 15000; // ۱۵ ثانیه

  // پارامترهای exponential backoff برای تلاش مجدد بعد از شکست.
  private static readonly BACKOFF_BASE_MINUTES = 5;
  private static readonly BACKOFF_MAX_MINUTES = 60;
  // بعد از این تعداد خطای موقت پشت‌سرهم، عضویت ناموفق اعلام و متوقف می‌شه.
  private static readonly MAX_JOIN_ATTEMPTS = 5;
  private isSyncingChannels = false;

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
    private readonly cargoPipeline: CargoPipelineService,
    private readonly membership: ChannelMembershipService,
    private readonly speechToTextService: SpeechToTextService,
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
    this.logger.log(`نسخه‌ی Baileys: ${version.join('.')}، آخرین نسخه‌ست: ${isLatest}`);

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

        this.logger.warn(`اتصال واتساپ قطع شد. اتصال مجدد انجام می‌شه: ${shouldReconnect}`);

        if (shouldReconnect) {
          this.connect();
        } else {
          this.logger.error('نشست بسته شد (loggedOut). QR جدید لازمه.');
        }
      } else if (connection === 'open') {
        this.logger.log('اتصال واتساپ برقرار شد.');
        void this.sock.updateProfileName('باربری تارابری').catch((err) =>
          this.logger.error('پروفایل نیم تنظیم نشد', err),
        );

        if (PERSONAL_NOTIFY_NUMBER) {
          this.resolvePersonalContact(PERSONAL_NOTIFY_NUMBER)
            .then((jid) => {
              this.personalNotifyJid = jid;
              this.logger.log(`شماره‌ی اعلان شخصی تایید شد: ${jid}`);
            })
            .catch((err) =>
              this.logger.error('شماره‌ی اعلان شخصی تایید نشد', err as Error),
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

      this.logger.warn(`🚫 ربات از گروه حذف شد: ${groupJid}`);

      const removedFrom = await this.monitoredChannelRepo.find({ where: { resolvedJid: groupJid } });
      for (const channel of removedFrom) {
        channel.isActive = false;
        channel.isFollowed = false;
        channel.lastError = 'ربات از گروه حذف شد (kicked/removed).';
        await this.membership.transition('whatsapp', channel, ChannelMembershipStatus.REMOVED, channel.lastError);
      }
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
    if (!this.sock || !isChannelMonitoringEnabled('whatsapp') || this.isSyncingChannels) return;

    // جلوی اجرای هم‌زمان cron رو می‌گیره -- وگرنه با صف طولانی (۱۵ ثانیه
    // فاصله برای هر گروه) یک گروه ممکن بود دو بار درخواست عضویت بگیره.
    this.isSyncingChannels = true;
    try {
      const pendingChannels = await this.monitoredChannelRepo.find({
        where: [
          { isActive: true, isFollowed: false, nextAttemptAt: IsNull() },
          { isActive: true, isFollowed: false, nextAttemptAt: LessThanOrEqual(new Date()) },
        ],
      });

      if (pendingChannels.length === 0) return;

      this.logger.log(`${pendingChannels.length} گروه/کانال جدید پیدا شد، در حال پردازش...`);

      for (const channel of pendingChannels) {
        await this.joinMonitoredChannel(channel);
      }
    } finally {
      this.isSyncingChannels = false;
    }
  }

  private async joinMonitoredChannel(channel: MonitoredChannel): Promise<void> {
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
      await this.membership.transition('whatsapp', channel, ChannelMembershipStatus.JOINED);

      this.logger.log(
        `${channel.type === MonitoredChatType.GROUP ? 'به گروه پیوست' : 'کانال دنبال شد'}: ${resolvedJid} (${channel.label ?? channel.identifier})`,
      );

      await new Promise((resolve) => setTimeout(resolve, WhatsappService.FOLLOW_DELAY_MS));
      return;
    } catch (error) {
      await this.handleJoinError(channel, error);
    }
  }

  private async handleJoinError(channel: MonitoredChannel, error: unknown): Promise<void> {
    channel.lastError = (error as Error)?.message ?? String(error);

    const permanent = error instanceof WhatsappPermanentJoinError;
    const pending = error instanceof WhatsappJoinPendingError;
    channel.retryCount += 1;

    // خطای دائمی، یا خطای موقتی که چند بار پشت‌سرهم تکرار شده -- دیگه تلاش نمی‌شه.
    if (permanent || (!pending && channel.retryCount >= WhatsappService.MAX_JOIN_ATTEMPTS)) {
      channel.isActive = false;
      channel.nextAttemptAt = null;
      await this.membership.transition('whatsapp', channel, ChannelMembershipStatus.FAILED, channel.lastError);
      this.logger.error(`عضویت ممکن نیست (${channel.type}): ${channel.identifier} -- ${channel.lastError}`);
      return;
    }

    // منتظر تایید ادمین: با همون backoff دوباره بررسی می‌شه تا تایید بشه.
    const backoffMinutes = exponentialBackoffMinutes(
      channel.retryCount,
      WhatsappService.BACKOFF_BASE_MINUTES,
      WhatsappService.BACKOFF_MAX_MINUTES,
    );
    channel.nextAttemptAt = new Date(Date.now() + backoffMinutes * 60 * 1000);

    if (pending) {
      await this.membership.transition('whatsapp', channel, ChannelMembershipStatus.PENDING, channel.lastError);
    } else {
      await this.monitoredChannelRepo.save(channel);
    }

    this.logger.error(
      `پردازش نشد (${channel.type}): ${channel.identifier} -- ${backoffMinutes} دقیقه‌ی دیگه دوباره تلاش می‌شه (تلاش #${channel.retryCount})`,
      error as Error,
    );
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
    if (!this.sock) throw new Error('سوکت واتساپ آماده نیست.');

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
      throw new Error(`شماره در واتساپ ثبت نشده: ${identifier}`);
    }

    return results[0].jid ?? `${digits}@s.whatsapp.net`;
  }

  private async followChannel(identifier: string): Promise<string> {
    if (!this.sock) throw new Error('سوکت واتساپ آماده نیست.');

    try {
      const metadata = identifier.endsWith('@newsletter')
        ? { id: identifier }
        : await this.sock.newsletterMetadata('invite', identifier);
      if (!metadata?.id) throw new WhatsappPermanentJoinError('کانالی با این لینک پیدا نشد.');

      await this.sock.newsletterFollow(metadata.id);
      return metadata.id;
    } catch (error) {
      throw toJoinError(error);
    }
  }

  private async joinGroup(identifier: string): Promise<string> {
    if (!this.sock) throw new Error('سوکت واتساپ آماده نیست.');

    if (identifier.endsWith('@g.us')) {
      return identifier;
    }

    try {
      const result = await this.sock.groupAcceptInvite(identifier);

      // گروهی که تایید ادمین لازم داره jid برنمی‌گردونه -- درخواست ثبت شده.
      if (!result || typeof result !== 'string') {
        throw new WhatsappJoinPendingError('درخواست عضویت فرستاده شد و منتظر تایید ادمین گروهه.');
      }

      return result;
    } catch (error) {
      if (error instanceof WhatsappJoinPendingError) throw error;
      this.logger.error(
        `جزئیات خام خطای groupAcceptInvite: ${JSON.stringify(error, Object.getOwnPropertyNames(error as object))}`,
      );
      throw toJoinError(error);
    }
  }

  // پیام‌ها یکی‌یکی پردازش می‌شن -- جلوگیری از درخواست‌های هم‌زمان به Ollama.
  private enqueueChannelMessage(msg: WAMessage): void {
    if (!isChannelMonitoringEnabled('whatsapp')) return;
    void this.messageQueue.run(() => this.handleChannelMessage(msg)).catch((error) =>
      this.logger.error(`خطا در پردازش پیام کانال/گروه: ${msg.key.remoteJid}`, error as Error),
    );
  }

  /**
   * پردازش کامل یک پیام جدید از گروه یا کانال: استخراج متن، تشخیص سفارش
   * بار، و فقط برای سفارش بار -- ذخیره در دیتابیس و انتشار یه event
   * (cargo.message.detected) از طریق Outbox Pattern برای توزیع‌کننده.
   */
  private async handleChannelMessage(msg: WAMessage): Promise<void> {
    const channelJid = msg.key.remoteJid!;
    const messageId = msg.key.id;

    if (!messageId) return;
    if (this.recentMessageIds.has(messageId)) return;

    const existing = await this.channelMessageRepo.findOne({ where: { messageId } });
    if (existing) return;

    let text =
      msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
    const audio = msg.message?.audioMessage;

    if (!text && !audio) return;

    this.recentMessageIds.add(messageId);

    // پیام صوتی: اول به متن تبدیل می‌شه و بعد مثل پیام متنی بررسی می‌شه.
    const isVoice = !text && !!audio;
    if (isVoice) {
      text = await this.speechToTextService.transcribeVoice(
        Number(audio!.seconds ?? 0),
        () =>
          downloadMediaMessage(msg, 'buffer', {}, {
            reuploadRequest: this.sock!.updateMediaMessage,
            logger: this.sock!.logger,
          }),
        `whatsapp ${channelJid} ${messageId}`,
      );
      if (!text) return;
    }

    // کاربری که این گروه/کانال رو ثبت کرده -- اعلان بار برای همون کاربر فرستاده می‌شه.
    const channel = await this.monitoredChannelRepo.findOne({
      where: { resolvedJid: channelJid },
      select: { id: true, ownerUserIds: true },
    });

    const extraction = await this.cargoPipeline.process({
      label: `${channelJid} ${messageId}`,
      text,
      isVoice,
      entity: WhatsappChannelMessage,
      record: { channelJid, messageId, isCargoOrder: true },
      source: { platform: 'whatsapp', channelJid },
      ownerUserIds: channel?.ownerUserIds ?? [],
    });
    if (!extraction) return;

    // فعلاً غیرفعال -- در این مرحله به صاحب بار/شماره‌های داخل پیام چیزی
    // فرستاده نمی‌شه. بعداً با متن واقعی جایگزین می‌شه.
    // if (extraction.found_phone_numbers && extraction.found_phone_numbers.length > 0) {
      // for (const rawNumber of extraction.found_phone_numbers) {
        // if (!this.isLikelyMobileNumber(rawNumber)) {
          // this.logger.log(`⏭️ چون تلفن ثابته رد شد: ${rawNumber}`);
          // continue;
        // }

        // try {
          // const customerJid = await this.resolvePersonalContact(rawNumber);
          // await this.sendMessage(customerJid, 'این یک پیام تستی از سیستم است.');
          // this.logger.log(
            // `📤 پیام تست ارسال شد: ${rawNumber} -> ${customerJid}`,
          // );
        // } catch (testError) {
          // this.logger.error(
            // `پیام تست ارسال نشد: ${rawNumber}`,
            // testError as Error,
          // );
        // }
      // }
    // }

    // if (extraction.is_cargo_order && this.personalNotifyJid) {
    //   try {
    //     await this.sendMessage(this.personalNotifyJid, text);
    //     this.logger.log(
    //       `📤 اعلان شخصی ارسال شد: [${channelJid}] -> [${this.personalNotifyJid}]`,
    //     );
    //   } catch (personalError) {
    //     this.logger.error(
    //       `اعلان شخصی ارسال نشد: [${channelJid}] -> [${this.personalNotifyJid}]`,
    //       personalError as Error,
    //     );
    //   }
    // }
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
          `📤 پیام فوروارد شد: [${sourceJid}] -> [${destination.resolvedJid}] (${destination.label ?? destination.identifier})`,
        );
        await new Promise((resolve) => setTimeout(resolve, 1000));
      } catch (forwardError) {
        this.logger.error(
          `فوروارد پیام ناموفق بود: [${sourceJid}] -> [${destination.resolvedJid}]`,
          forwardError as Error,
        );
      }
    }
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.sock) {
      this.logger.error('سوکت واتساپ آماده نیست.');
      return;
    }

    const SEND_TIMEOUT_MS = 15000;

    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`مهلت sendMessage تموم شد: ${jid}`)), SEND_TIMEOUT_MS);
    });

    try {
      await Promise.race([this.sock.sendMessage(jid, { text }), timeoutPromise]);
    } catch (error) {
      this.logger.error(`sendMessage ناموفق بود: ${jid}`, error as Error);
    }
  }
}