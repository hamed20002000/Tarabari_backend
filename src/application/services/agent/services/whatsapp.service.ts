import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, IsNull, LessThanOrEqual, In, Not } from 'typeorm';
import { Cron } from '@nestjs/schedule';
import makeWASocket, {
  DisconnectReason,
  WASocket,
  WAMessage,
  GroupParticipant,
  areJidsSameUser,
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
const PROFILE_NAME = 'باربری تارابری';

// پایه‌ی همه‌ی خطاهای دسته‌بندی‌شده‌ی عضویت -- toJoinError دوباره دسته‌بندیشون نمی‌کنه.
class WhatsappJoinError extends Error { }
// درخواست عضویت ثبت شده و منتظر تایید ادمین گروهه.
class WhatsappJoinPendingError extends WhatsappJoinError { }
// خطایی که با تلاش دوباره درست نمی‌شه (لینک نامعتبر/باطل، بن شدن).
class WhatsappPermanentJoinError extends WhatsappJoinError { }
// اتصال واتساپ قطعه یا درخواست timeout شد -- تقصیر گروه نیست و جزو تلاش‌ها حساب نمی‌شه.
class WhatsappConnectionError extends WhatsappJoinError { }
// واتساپ گفته درخواست‌ها زیاد شده (rate-overlimit) -- باید کلاً مدتی صبر کرد.
class WhatsappRateLimitError extends WhatsappJoinError { }

// کدهای HTTP که Baileys (Boom) برای خطاهای دائمی عضویت برمی‌گردونه.
const PERMANENT_JOIN_STATUS: Record<number, string> = {
  400: 'لینک دعوت نامعتبره.',
  401: 'ربات اجازه‌ی عضویت در این گروه/کانال رو نداره (لینک دعوت عوض شده، یا ربات قبلاً حذف یا بن شده).',
  403: 'ربات اجازه‌ی عضویت در این گروه/کانال رو نداره.',
  404: 'گروه/کانالی با این لینک پیدا نشد.',
  406: 'لینک دعوت نامعتبره.',
  410: 'لینک دعوت باطل یا منقضی شده.',
};

/**
 * کد خطای واتساپ. خطاهای سمت سرور واتساپ (assertNodeErrorFree در Baileys)
 * کد واقعی رو در data می‌ذارن و statusCode اونا همیشه 500ـه؛ خطاهای اتصال
 * (Connection Closed، Timed Out) کد رو در output.statusCode دارن.
 */
function whatsappErrorCode(error: unknown): number | undefined {
  const boom = error as Boom;
  if (typeof boom?.data === 'number') return boom.data;
  return boom?.output?.statusCode;
}

function toJoinError(error: unknown): Error {
  if (error instanceof WhatsappJoinError) return error;
  const status = whatsappErrorCode(error);
  const message = (error as Error)?.message ?? String(error);
  if (status === DisconnectReason.connectionClosed || status === DisconnectReason.timedOut) {
    return new WhatsappConnectionError(`اتصال واتساپ برقرار نیست: ${message}`);
  }
  if (status === 429) return new WhatsappRateLimitError('واتساپ تعداد درخواست‌ها رو محدود کرد (rate-overlimit).');
  if (status && PERMANENT_JOIN_STATUS[status]) return new WhatsappPermanentJoinError(PERMANENT_JOIN_STATUS[status]);
  return new WhatsappJoinError(`عضویت ناموفق بود: ${message}`);
}

@Injectable()
export class WhatsappService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WhatsappService.name);
  private sock: WASocket | null = null;

  // صف پیام‌های گروه/کانال که هنوز پردازش نشدن -- جلوگیری از فرستادن
  // چند درخواست هم‌زمان به Ollama که باعث timeout می‌شد.
  private readonly messageQueue = new SerialTaskQueue();

  // شناسه‌ی پیام‌هایی که اخیراً بررسی شدن -- چون فقط پیام‌های بار توی
  // دیتابیس ذخیره می‌شن، این کش جلوی فرستادن دوباره‌ی پیام‌های غیربارِ
  // تکراری (redelivery واتساپ) به مدل رو می‌گیره.
  private readonly recentMessageIds = new RecentIdCache(1000);

  // حداقل فاصله بین هر دو درخواست عضویت/استعلام لینک به واتساپ (به‌اضافه‌ی
  // کمی تصادفی) -- جلوگیری از الگوی burst مشکوک که باعث مسدود شدن شماره می‌شه.
  private static readonly FOLLOW_DELAY_MS = 15000; // ۱۵ ثانیه
  private static readonly FOLLOW_JITTER_MS = 10000; // تا ۱۰ ثانیه‌ی اضافه
  // سقف عضویت (درخواست واقعی join/follow) در یک ساعت. باقی‌مونده‌ها در صف
  // می‌مونن و دورهای بعدی انجام می‌شن.
  private static readonly MAX_JOINS_PER_HOUR = 10;
  // اگه واتساپ rate-overlimit داد، این مدت هیچ درخواست عضویتی فرستاده نمی‌شه.
  private static readonly RATE_LIMIT_PAUSE_MINUTES = 60;

  // پارامترهای exponential backoff برای تلاش مجدد بعد از شکست.
  private static readonly BACKOFF_BASE_MINUTES = 5;
  private static readonly BACKOFF_MAX_MINUTES = 60;
  // بعد از این تعداد خطای موقت پشت‌سرهم، عضویت ناموفق اعلام و متوقف می‌شه.
  private static readonly MAX_JOIN_ATTEMPTS = 5;
  // درخواست عضویتی که منتظر تایید ادمینه دوباره فرستاده نمی‌شه؛ فقط با این
  // backoff بررسی می‌شه که عضو شدیم یا نه. بعد از این تعداد بررسی (حدوداً ۳
  // روز با سقف ۶۰ دقیقه) ناموفق اعلام می‌شه.
  private static readonly MAX_PENDING_CHECKS = 72;
  // پیام‌های 'append' (رسیده در زمان قطعی) قدیمی‌تر از این پردازش نمی‌شن.
  private static readonly MAX_APPEND_MESSAGE_AGE_MS = 60 * 60 * 1000;
  private isSyncingChannels = false;

  // وضعیت واقعی اتصال -- this.sock بعد از قطع شدن هم null نمی‌شه.
  private isConnected = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private isShuttingDown = false;

  private lastJoinRequestAt = 0;
  private recentJoinTimes: number[] = [];
  private joinsPausedUntil = 0;

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
    // استارت برنامه منتظر واتساپ نمی‌مونه؛ اگه اتصال اول fail بشه، دوباره تلاش می‌شه.
    this.connect().catch((error) => {
      this.logger.error('اتصال به واتساپ ناموفق بود', error as Error);
      this.scheduleReconnect();
    });
  }

  /**
   * موقع خاموش شدن (و هر ری‌استارت --watch) سوکت بسته می‌شه. وگرنه پروسه‌ی
   * قبلی و جدید چند لحظه هم‌زمان با یک نشست وصل می‌موندن -- واتساپ این رو
   * conflict می‌بینه و تکرارش می‌تونه دستگاه رو از حساب جدا کنه.
   */
  onModuleDestroy(): void {
    this.isShuttingDown = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.sock?.end(undefined);
  }

  /**
   * اتصال مجدد با فاصله‌ی ۲، ۴، ۸ ... تا حداکثر ۶۰ ثانیه. اگه خود connect
   * خطا بده (دیتابیس، شبکه)، دوباره زمان‌بندی می‌شه -- وگرنه برنامه تا
   * ری‌استارت بعدی بی‌صدا از واتساپ جدا می‌موند.
   */
  private scheduleReconnect(immediate = false): void {
    if (this.reconnectTimer || this.isShuttingDown) return;
    const delayMs = immediate ? 0 : Math.min(2000 * 2 ** this.reconnectAttempts, 60000);
    if (!immediate) this.reconnectAttempts += 1;
    this.logger.warn(`اتصال مجدد واتساپ ${delayMs / 1000} ثانیه‌ی دیگه (تلاش #${this.reconnectAttempts})`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch((error) => {
        this.logger.error('اتصال مجدد به واتساپ ناموفق بود', error as Error);
        this.scheduleReconnect();
      });
    }, delayMs);
  }

  private async clearAuthState(): Promise<void> {
    await this.keyRepo.delete({ sessionId: DEFAULT_SESSION_ID });
    await this.credentialRepo.delete({ sessionId: DEFAULT_SESSION_ID });
  }

  private async connect(): Promise<void> {
    const { state, saveCreds } = await useDbAuthState(
      DEFAULT_SESSION_ID,
      this.credentialRepo,
      this.keyRepo,
    );

    // fetch داخل fetchLatestBaileysVersion مهلت نداره -- با شبکه‌ی کند اتصال گیر می‌کرد.
    const { version, isLatest } = await Promise.race([
      fetchLatestBaileysVersion(),
      new Promise<Awaited<ReturnType<typeof fetchLatestBaileysVersion>>>((resolve) =>
        setTimeout(() => resolve({ version: undefined as never, isLatest: false }), 10000),
      ),
    ]);
    this.logger.log(`نسخه‌ی Baileys: ${version?.join('.') ?? 'پیش‌فرض'}، آخرین نسخه‌ست: ${isLatest}`);

    this.sock = makeWASocket({
      auth: state,
      // بدون version، نسخه‌ی پیش‌فرض خود Baileys استفاده می‌شه (undefined پیش‌فرض رو خراب می‌کرد).
      ...(version ? { version } : {}),
      printQRInTerminal: false,
    });

    this.sock.ev.on('creds.update', saveCreds);

    this.sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        qrcode.generate(qr, { small: true });
      }

      if (connection === 'close') {
        this.isConnected = false;
        const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
        this.logger.warn(`اتصال واتساپ قطع شد (کد ${statusCode}).`);
        if (this.isShuttingDown) return;

        if (statusCode === DisconnectReason.restartRequired) {
          // بعد از اسکن QR واتساپ اتصال رو می‌بنده و انتظار داره فوراً دوباره
          // وصل بشیم تا pairing کامل بشه -- تاخیر backoff اینجا باعث جدا شدن دستگاه می‌شد.
          this.reconnectAttempts = 0;
          this.scheduleReconnect(true);
        } else if (statusCode === DisconnectReason.connectionReplaced) {
          // یه پروسه‌ی دیگه با همین نشست وصل شده. اگه اینجا دوباره وصل بشیم،
          // دو پروسه مدام همدیگه رو بیرون می‌کنن و واتساپ دستگاه رو logout می‌کنه.
          this.logger.error(
            'نشست واتساپ در پروسه‌ی دیگه‌ای باز شد (connectionReplaced) -- اتصال مجدد انجام نمی‌شه. فقط یک نمونه از برنامه اجرا کنید و ری‌استارت کنید.',
          );
        } else if (statusCode !== DisconnectReason.loggedOut) {
          this.scheduleReconnect();
        } else {
          // کلیدهای نشستِ logout‌شده دیگه به درد نمی‌خورن و با وجودشون هر
          // اتصال دوباره هم 401 می‌گیره -- پاک می‌شن تا QR جدید نمایش داده بشه.
          this.logger.error('نشست بسته شد (loggedOut). کلیدهای قبلی پاک می‌شن و QR جدید نمایش داده می‌شه.');
          void this.clearAuthState()
            .then(() => this.scheduleReconnect())
            .catch((error) => this.logger.error('پاک کردن نشست واتساپ ناموفق بود', error as Error));
        }
      } else if (connection === 'open') {
        this.isConnected = true;
        this.reconnectAttempts = 0;
        this.logger.log('اتصال واتساپ برقرار شد.');
        // updateProfileName یه app-state patch می‌فرسته؛ روی نشستی که هنوز
        // app-state رو sync نکرده سرور item-not-found برمی‌گردونه. خطاش
        // بی‌خطره و اتصال کار می‌کنه، پس فقط وقتی اسم فرق داره تلاش می‌کنیم.
        if (this.sock.user?.name !== PROFILE_NAME) {
          void this.sock.updateProfileName(PROFILE_NAME).catch((err) =>
            this.logger.warn(`پروفایل نیم تنظیم نشد: ${(err as Error).message}`),
          );
        }

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

      if (action !== 'add' && action !== 'remove') return;
      if (!participants.some((p) => this.isMe(p))) return;

      if (action === 'add') {
        await this.onAddedToGroup(groupJid).catch((error) =>
          this.logger.error(`ثبت عضویت گروه ناموفق بود: ${groupJid}`, error as Error),
        );
        return;
      }

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
      // 'append' هم پیام جدیده: پیام‌هایی که موقع قطع بودن ربات رسیدن (offline)
      // و پست‌های کانال که Baileys از مسیر notification می‌گیره با 'append' میان.
      // فقط پیام‌های تازه پردازش می‌شن تا بارهای قدیمی دوباره اعلام نشن.
      if (type !== 'notify' && type !== 'append') return;

      for (const msg of messages) {
        if (!msg.message) continue;

        const remoteJid = msg.key.remoteJid;
        if (!remoteJid?.endsWith('@newsletter') && !remoteJid?.endsWith('@g.us')) continue;

        if (type === 'append') {
          const sentAtMs = Number(msg.messageTimestamp ?? 0) * 1000;
          if (Date.now() - sentAtMs > WhatsappService.MAX_APPEND_MESSAGE_AGE_MS) continue;
        }

        this.enqueueChannelMessage(msg);
      }
    });
  }

  // ------------------------------------------------------------------
  // مدیریت گروه‌ها و کانال‌های مانیتور شده -- خوانده‌شده از دیتابیس
  // ------------------------------------------------------------------

  @Cron('*/2 * * * *')
  async syncMonitoredChannels(): Promise<void> {
    if (!this.sock || !this.isConnected || !isChannelMonitoringEnabled('whatsapp') || this.isSyncingChannels) return;
    if (Date.now() < this.joinsPausedUntil) return;

    // جلوی اجرای هم‌زمان cron رو می‌گیره -- وگرنه با صف طولانی یک گروه
    // ممکن بود دو بار درخواست عضویت بگیره.
    this.isSyncingChannels = true;
    try {
      const pendingChannels = await this.monitoredChannelRepo.find({
        where: [
          { isActive: true, isFollowed: false, nextAttemptAt: IsNull() },
          { isActive: true, isFollowed: false, nextAttemptAt: LessThanOrEqual(new Date()) },
        ],
        order: { createdAt: 'ASC' },
      });

      if (pendingChannels.length === 0) return;

      this.logger.log(`${pendingChannels.length} گروه/کانال در صف عضویت، در حال پردازش...`);

      // یه کوئری برای همه: گروه‌هایی که ربات الان عضوشونه. با این، گروهی که
      // ادمین تایید کرده یا قبلاً عضوش بودیم بدون درخواست دوباره JOINED می‌شه.
      const joinedGroups = pendingChannels.some((c) => c.type === MonitoredChatType.GROUP)
        ? new Set(Object.keys(await this.sock.groupFetchAllParticipating()))
        : new Set<string>();

      for (const channel of pendingChannels) {
        if (!this.isConnected || Date.now() < this.joinsPausedUntil) break;
        const stop = await this.joinMonitoredChannel(channel, joinedGroups);
        if (stop) break;
      }
    } catch (error) {
      this.logger.error('همگام‌سازی گروه/کانال‌های واتساپ ناموفق بود', error as Error);
    } finally {
      this.isSyncingChannels = false;
    }
  }

  /** @returns true اگه باید بقیه‌ی صف این دور متوقف بشه (قطعی اتصال، محدودیت واتساپ). */
  private async joinMonitoredChannel(channel: MonitoredChannel, joinedGroups: Set<string>): Promise<boolean> {
    try {
      const resolvedJid =
        channel.type === MonitoredChatType.GROUP
          ? await this.joinGroup(channel, joinedGroups)
          : await this.followChannel(channel.identifier);

      if (!resolvedJid) {
        // سقف عضویت ساعتی پر شده -- رکورد دست نمی‌خوره و دور بعدی انجام می‌شه.
        return true;
      }

      await this.markJoined(channel, resolvedJid);
      return false;
    } catch (error) {
      return this.handleJoinError(channel, toJoinError(error));
    }
  }

  private async markJoined(channel: MonitoredChannel, resolvedJid: string): Promise<void> {
    channel.resolvedJid = resolvedJid;
    channel.isFollowed = true;
    channel.isActive = true;
    channel.lastError = null;
    channel.retryCount = 0;
    channel.nextAttemptAt = null;
    await this.membership.transition('whatsapp', channel, ChannelMembershipStatus.JOINED);

    this.logger.log(
      `${channel.type === MonitoredChatType.GROUP ? 'به گروه پیوست' : 'کانال دنبال شد'}: ${resolvedJid} (${channel.label ?? channel.identifier})`,
    );
  }

  /** ادمین درخواست رو تایید کرد یا کسی ربات رو به گروه اضافه کرد. */
  private async onAddedToGroup(groupJid: string): Promise<void> {
    this.logger.log(`✅ ربات به گروه اضافه شد: ${groupJid}`);
    const channels = await this.monitoredChannelRepo.find({ where: { resolvedJid: groupJid, isFollowed: false } });
    for (const channel of channels) {
      await this.markJoined(channel, groupJid);
    }
    if (channels.length > 0) return;

    // گروه‌های منتظر تاییدی که JIDشون هنوز معلوم نیست -- یکیشون احتمالاً همینه.
    // بررسی بعدیشون جلو می‌افته تا با استعلام لینک (حالا که عضویم) پیدا بشه.
    const unresolved = await this.monitoredChannelRepo.find({
      where: { type: MonitoredChatType.GROUP, isFollowed: false, resolvedJid: IsNull() },
    });
    if (unresolved.length === 0) return;
    for (const channel of unresolved) channel.nextAttemptAt = null;
    await this.monitoredChannelRepo.save(unresolved);
    void this.syncMonitoredChannels();
  }

  /** @returns true اگه باید بقیه‌ی صف این دور متوقف بشه. */
  private async handleJoinError(channel: MonitoredChannel, error: Error): Promise<boolean> {
    channel.lastError = error.message;

    // قطعی اتصال: تقصیر گروه نیست -- تلاش حساب نمی‌شه و بعد از وصل شدن ادامه پیدا می‌کنه.
    if (error instanceof WhatsappConnectionError) {
      await this.monitoredChannelRepo.save(channel);
      this.logger.warn(`عضویت ${channel.identifier} عقب افتاد: ${error.message}`);
      return true;
    }

    // محدودیت واتساپ: کل عضویت‌ها یه مدت متوقف می‌شن تا شماره مسدود نشه.
    if (error instanceof WhatsappRateLimitError) {
      this.joinsPausedUntil = Date.now() + WhatsappService.RATE_LIMIT_PAUSE_MINUTES * 60 * 1000;
      channel.nextAttemptAt = new Date(this.joinsPausedUntil);
      await this.monitoredChannelRepo.save(channel);
      this.logger.error(
        `⛔ واتساپ محدودیت گذاشت -- عضویت‌ها ${WhatsappService.RATE_LIMIT_PAUSE_MINUTES} دقیقه متوقف شدن.`,
      );
      return true;
    }

    const permanent = error instanceof WhatsappPermanentJoinError;
    const pending = error instanceof WhatsappJoinPendingError;
    channel.retryCount += 1;

    const exhausted = pending
      ? channel.retryCount >= WhatsappService.MAX_PENDING_CHECKS
      : channel.retryCount >= WhatsappService.MAX_JOIN_ATTEMPTS;

    // خطای دائمی، خطای موقتی که چند بار تکرار شده، یا درخواستی که مدت‌ها
    // تایید نشده -- دیگه تلاش نمی‌شه. با فعال‌سازی دوباره از پنل، از اول شروع می‌شه.
    if (permanent || exhausted) {
      if (pending) channel.lastError = 'ادمین گروه درخواست عضویت رو تایید نکرد.';
      channel.isActive = false;
      channel.nextAttemptAt = null;
      await this.membership.transition('whatsapp', channel, ChannelMembershipStatus.FAILED, channel.lastError);
      this.logger.error(`عضویت ممکن نیست (${channel.type}): ${channel.identifier} -- ${channel.lastError}`);
      return false;
    }

    const backoffMinutes = exponentialBackoffMinutes(
      channel.retryCount,
      WhatsappService.BACKOFF_BASE_MINUTES,
      WhatsappService.BACKOFF_MAX_MINUTES,
    );
    channel.nextAttemptAt = new Date(Date.now() + backoffMinutes * 60 * 1000);

    if (pending) {
      await this.membership.transition('whatsapp', channel, ChannelMembershipStatus.PENDING, channel.lastError);
      this.logger.log(`⏳ منتظر تایید ادمین: ${channel.identifier} -- ${backoffMinutes} دقیقه‌ی دیگه بررسی می‌شه`);
    } else {
      await this.monitoredChannelRepo.save(channel);
      this.logger.error(
        `پردازش نشد (${channel.type}): ${channel.identifier} -- ${backoffMinutes} دقیقه‌ی دیگه دوباره تلاش می‌شه (تلاش #${channel.retryCount})`,
        error,
      );
    }
    return false;
  }

  private isMe(participant: GroupParticipant): boolean {
    const me = this.sock?.user;
    if (!me) return false;
    const myIds = [me.id, me.lid].filter((jid): jid is string => !!jid);
    return [participant.id, participant.phoneNumber, participant.lid].some(
      (jid) => !!jid && myIds.some((mine) => areJidsSameUser(jid, mine)),
    );
  }

  /**
   * قبل از هر درخواست عضویت/استعلام لینک صدا زده می‌شه: فاصله‌ی حداقل
   * FOLLOW_DELAY_MS (+ کمی تصادفی) از درخواست قبلی رو رعایت می‌کنه.
   */
  private async throttleJoinRequest(): Promise<void> {
    const gap = WhatsappService.FOLLOW_DELAY_MS + Math.random() * WhatsappService.FOLLOW_JITTER_MS;
    const waitMs = this.lastJoinRequestAt + gap - Date.now();
    if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
    this.lastJoinRequestAt = Date.now();
  }

  private hasJoinQuota(): boolean {
    const hourAgo = Date.now() - 60 * 60 * 1000;
    this.recentJoinTimes = this.recentJoinTimes.filter((time) => time > hourAgo);
    return this.recentJoinTimes.length < WhatsappService.MAX_JOINS_PER_HOUR;
  }

  /** سهمیه‌ی عضویت ساعتی رو چک و در صورت امکان مصرف می‌کنه. */
  private takeJoinQuota(): boolean {
    if (!this.hasJoinQuota()) return false;
    this.recentJoinTimes.push(Date.now());
    return true;
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

  private async followChannel(identifier: string): Promise<string | null> {
    if (!this.sock) throw new Error('سوکت واتساپ آماده نیست.');

    try {
      // سهمیه پر باشه، استعلام هم انجام نمی‌شه (وگرنه هر دور cron یه استعلام بی‌فایده می‌رفت).
      if (!this.hasJoinQuota()) return null;

      await this.throttleJoinRequest();
      const metadata = await this.sock.newsletterMetadata('invite', identifier);
      if (!metadata?.id) throw new WhatsappPermanentJoinError('کانالی با این لینک پیدا نشد.');

      // اگه قبلاً دنبالش کردیم (یا ادمینشیم)، درخواست follow دوباره نمی‌ره.
      const role = (metadata as { viewer_metadata?: { role?: string } }).viewer_metadata?.role;
      if (role && role !== 'GUEST') return metadata.id;

      if (!this.takeJoinQuota()) return null;
      await this.throttleJoinRequest();
      await this.sock.newsletterFollow(metadata.id);
      return metadata.id;
    } catch (error) {
      throw toJoinError(error);
    }
  }

  /**
   * عضویت در گروه با کمترین درخواست ممکن به واتساپ:
   *   ۱. JID گروه با استعلام لینک (بدون عضویت) پیدا و ذخیره می‌شه.
   *   ۲. اگه ربات همین الان عضوه (تایید ادمین، عضویت قبلی) -- درخواستی نمی‌ره.
   *   ۳. اگه قبلاً درخواست داده شده و منتظر تاییده -- دوباره فرستاده نمی‌شه.
   *   ۴. فقط در غیر این صورت درخواست عضویت فرستاده می‌شه.
   * @returns JID گروه، یا null اگه سقف عضویت ساعتی پر شده.
   */
  private async joinGroup(channel: MonitoredChannel, joinedGroups: Set<string>): Promise<string | null> {
    if (!this.sock) throw new WhatsappConnectionError('سوکت واتساپ آماده نیست.');

    try {
      if (!channel.resolvedJid) {
        await this.throttleJoinRequest();
        const info = await this.sock.groupGetInviteInfo(channel.identifier).catch((error: Boom) => {
          // واتساپ برای گروهی که قبلاً درخواست عضویتش داده شده و منتظر تاییده،
          // به‌جای اطلاعات گروه جواب دیگه‌ای برمی‌گردونه. درخواست دوباره
          // فرستاده نمی‌شه؛ بعد از تایید، استعلام لینک جواب می‌ده.
          if (error?.message?.startsWith('Invalid group metadata response')) {
            this.logger.warn(
              `استعلام لینک ${channel.identifier} اطلاعات گروه نداد: ${JSON.stringify(error.data)?.slice(0, 1000)}`,
            );
            throw new WhatsappJoinPendingError(
              'واتساپ اطلاعات گروه رو نداد -- احتمالاً درخواست عضویت قبلی هنوز منتظر تایید ادمین گروهه.',
            );
          }
          throw error;
        });
        if (!info?.id) throw new WhatsappPermanentJoinError('گروهی با این لینک پیدا نشد.');
        channel.resolvedJid = info.id;
        await this.monitoredChannelRepo.save(channel);
      }

      if (joinedGroups.has(channel.resolvedJid)) return channel.resolvedJid;

      if (channel.membershipStatus === ChannelMembershipStatus.PENDING) {
        throw new WhatsappJoinPendingError('درخواست عضویت قبلاً فرستاده شده و منتظر تایید ادمین گروهه.');
      }

      if (!this.takeJoinQuota()) return null;

      await this.throttleJoinRequest();
      const result = await this.sock.groupAcceptInvite(channel.identifier);

      // گروهی که تایید ادمین لازم داره jid برنمی‌گردونه -- درخواست ثبت شده.
      if (!result || typeof result !== 'string') {
        throw new WhatsappJoinPendingError('درخواست عضویت فرستاده شد و منتظر تایید ادمین گروهه.');
      }

      return result;
    } catch (error) {
      // 409: ربات از قبل عضو گروهه.
      if (whatsappErrorCode(error) === 409 && channel.resolvedJid) return channel.resolvedJid;
      if (!(error instanceof Error) || !('isBoom' in error)) throw error;
      this.logger.error(
        `جزئیات خام خطای عضویت گروه: ${JSON.stringify(error, Object.getOwnPropertyNames(error as object))}`,
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