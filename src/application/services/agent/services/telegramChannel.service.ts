import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  Repository,
  IsNull,
  LessThanOrEqual,
  MoreThanOrEqual,
  Not,
  In,
} from 'typeorm';
import { Cron } from '@nestjs/schedule';
import { TelegramClient, Api, utils } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { NewMessage, NewMessageEvent } from 'telegram/events';
import { FloodWaitError, RPCError } from 'telegram/errors';
import { LogLevel } from 'telegram/extensions/Logger';
import { TelegramMonitoredChannel } from '../entities/TelegramMonitoredChannel';
import { TelegramChannelMessage } from '../entities/TelegramChannelMessage';
import { TelegramUserSession } from '../entities/TelegramUserSession';
import { MonitoredChatType, MonitoredChannelRole } from '../types';
import { SpeechToTextService } from './speechToText.service';
import { CargoPipelineService } from './cargoPipeline.service';
import { SerialTaskQueue } from '../common/serialTaskQueue';
import { RecentIdCache } from '../common/recentIdCache';
import { exponentialBackoffMinutes } from '../common/backoff';
import {
  TELEGRAM_SESSION_ID,
  buildTelegramClientParams,
  getTelegramApiCredentials,
} from './telegramClient.config';

interface IncomingChatMessage {
  chatId: string;
  messageId: number;
  text: string;
  // برای پیام صوتی: خود پیام نگه داشته می‌شه تا فایلش موقع پردازش دانلود بشه.
  voiceMessage?: Api.Message;
}

interface JoinResult {
  chatId: string | null;
  title: string | null;
  type: MonitoredChatType | null;
  pending: boolean;
}

type ParsedIdentifier = { kind: 'invite'; hash: string } | { kind: 'username'; username: string };

// خطاهایی که با تلاش دوباره درست نمی‌شن -- رکورد غیرفعال می‌شه تا مدیر لینک رو اصلاح کنه.
class PermanentJoinError extends Error { }

const PERMANENT_JOIN_ERRORS: Record<string, string> = {
  INVITE_HASH_EXPIRED: 'لینک دعوت منقضی شده.',
  INVITE_HASH_INVALID: 'لینک دعوت نامعتبره.',
  INVITE_HASH_EMPTY: 'لینک دعوت خالیه.',
  USERNAME_NOT_OCCUPIED: 'گروه/کانالی با این آیدی وجود نداره.',
  USERNAME_INVALID: 'آیدی نامعتبره.',
  CHANNEL_PRIVATE: 'گروه/کانال خصوصیه یا اکانت ازش حذف/بن شده.',
  CHANNEL_INVALID: 'گروه/کانال نامعتبره.',
  USER_BANNED_IN_CHANNEL: 'اکانت در این گروه/کانال بن شده.',
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const randomBetween = (min: number, max: number) => min + Math.random() * (max - min);

/**
 * گوش دادن به گروه/کانال‌های تلگرام با یک اکانت کاربری (GramJS / MTProto) و
 * ذخیره‌ی پیام‌های بار -- معادل تلگرامیِ بخش گروه/کانال در WhatsappService.
 *
 * ملاحظات ضد بن:
 *   - اکانت فقط می‌خونه؛ هیچ پیامی از این اکانت فرستاده نمی‌شه.
 *   - عضویت‌ها یکی‌یکی و با فاصله‌ی تصادفی (پیش‌فرض ۱۰ تا ۲۰ دقیقه) انجام می‌شن.
 *   - سقف روزانه برای تلاش‌های عضویت (پیش‌فرض ۲۰).
 *   - با FloodWait، کل عملیات عضویت تا پایان زمان انتظار (+ حاشیه) متوقف می‌شه.
 *   - هر لینک فقط یک بار resolve می‌شه و بعدش chatId ذخیره می‌شه.
 */
@Injectable()
export class TelegramChannelService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TelegramChannelService.name);
  private client: TelegramClient | null = null;

  private readonly messageQueue = new SerialTaskQueue();

  // کلید `${chatId}:${messageId}` -- جلوی فرستادن دوباره‌ی پیام‌های غیربارِ
  // تکراری به مدل رو می‌گیره (چون این‌ها توی دیتابیس ذخیره نمی‌شن).
  private readonly recentMessageKeys = new RecentIdCache(1000);

  private static readonly JOIN_MIN_INTERVAL_MINUTES =
    Number(process.env.TELEGRAM_JOIN_MIN_INTERVAL_MINUTES) || 10;
  private static readonly JOIN_JITTER_MINUTES = 10;
  private static readonly DAILY_JOIN_LIMIT = Number(process.env.TELEGRAM_DAILY_JOIN_LIMIT) || 20;
  private static readonly PENDING_RECHECK_MINUTES = 30;
  private static readonly PENDING_RECHECK_MAX_MINUTES = 24 * 60;
  private static readonly BACKOFF_BASE_MINUTES = 15;
  private static readonly BACKOFF_MAX_MINUTES = 6 * 60;

  // بعد از هر ری‌استارت هم چند دقیقه صبر می‌کنیم تا عضویت‌ها پشت‌سرهم نشن.
  private nextJoinAllowedAt = Date.now() + randomBetween(2, 5) * 60_000;
  private floodWaitUntil = 0;
  private isSyncing = false;

  constructor(
    @InjectRepository(TelegramMonitoredChannel)
    private readonly monitoredChannelRepo: Repository<TelegramMonitoredChannel>,
    @InjectRepository(TelegramChannelMessage)
    private readonly channelMessageRepo: Repository<TelegramChannelMessage>,
    @InjectRepository(TelegramUserSession)
    private readonly sessionRepo: Repository<TelegramUserSession>,
    private readonly cargoPipeline: CargoPipelineService,
    private readonly speechToTextService: SpeechToTextService,
  ) { }

  onModuleInit() {
    // اتصال به تلگرام نباید بالا اومدن کل برنامه رو معطل کنه.
    void this.start();
  }

  async onModuleDestroy() {
    await this.client?.disconnect().catch(() => undefined);
  }

  private async start(): Promise<void> {
    const credentials = getTelegramApiCredentials();
    if (!credentials) {
      this.logger.warn('TELEGRAM_API_ID/TELEGRAM_API_HASH تعریف نشده -- مانیتورینگ تلگرام غیرفعاله.');
      return;
    }

    const stored = await this.sessionRepo.findOne({ where: { sessionId: TELEGRAM_SESSION_ID } });
    if (!stored) {
      this.logger.warn('نشست تلگرام پیدا نشد -- یک بار `npm run telegram:login` رو اجرا کنید.');
      return;
    }

    try {
      const client = new TelegramClient(
        new StringSession(stored.session),
        credentials.apiId,
        credentials.apiHash,
        buildTelegramClientParams(),
      );
      client.setLogLevel(LogLevel.ERROR);

      await client.connect();

      if (!(await client.checkAuthorization())) {
        this.logger.error('نشست تلگرام نامعتبره (احتمالاً از دستگاه دیگه خارج شده) -- دوباره `npm run telegram:login` رو اجرا کنید.');
        await client.disconnect();
        return;
      }

      // اگه کلید نشست عوض شده باشه (مثلاً انتقال به دیتاسنتر دیگه)، نسخه‌ی جدید ذخیره می‌شه.
      const savedSession = client.session.save() as unknown as string;
      if (savedSession && savedSession !== stored.session) {
        await this.sessionRepo.update({ sessionId: TELEGRAM_SESSION_ID }, { session: savedSession });
      }

      client.addEventHandler(
        (event: NewMessageEvent) => this.onNewMessage(event),
        new NewMessage({ incoming: true }),
      );

      const me = await client.getMe();
      // مثل یک کلاینت واقعی، لیست گفتگوها رو یک بار می‌گیره -- هم کش entityها
      // پر می‌شه و هم تلگرام آپدیت‌های کانال‌ها رو برای این نشست می‌فرسته.
      await client.getDialogs({ limit: 100 });

      this.client = client;
      this.logger.log(`اکانت تلگرام متصل شد: ${me.username ? '@' + me.username : me.id.toString()}`);
    } catch (error) {
      this.logger.error('اتصال به تلگرام ناموفق بود', error as Error);
    }
  }

  // ------------------------------------------------------------------
  // دریافت پیام‌ها
  // ------------------------------------------------------------------

  private onNewMessage(event: NewMessageEvent): void {
    const msg = event.message;
    if (!msg || event.isPrivate) return;

    const text = (msg.message || '').trim();
    const isVoice = !text && !!msg.voice;
    if (!text && !isVoice) return;

    let chatId: string;
    try {
      chatId = utils.getPeerId(msg.peerId);
    } catch {
      return;
    }

    const incoming: IncomingChatMessage = {
      chatId,
      messageId: msg.id,
      text,
      voiceMessage: isVoice ? msg : undefined,
    };

    // پیام‌ها یکی‌یکی پردازش می‌شن -- جلوگیری از درخواست‌های هم‌زمان به Ollama.
    void this.messageQueue.run(() => this.handleChatMessage(incoming)).catch((error) =>
      this.logger.error(`خطا در پردازش پیام گروه/کانال تلگرام: ${chatId}`, error as Error),
    );
  }

  /**
   * پردازش یک پیام جدید از گروه یا کانال تلگرام: تشخیص سفارش بار، و فقط
   * برای سفارش بار -- ذخیره در دیتابیس و انتشار event
   * (cargo.message.detected) از طریق Outbox Pattern برای توزیع‌کننده.
   */
  private async handleChatMessage({ chatId, messageId, text, voiceMessage }: IncomingChatMessage): Promise<void> {
    const key = `${chatId}:${messageId}`;
    if (this.recentMessageKeys.has(key)) return;

    // فقط از گروه/کانال‌هایی که به‌عنوان منبع ثبت و فعال شدن پیام می‌خونیم.
    const channel = await this.monitoredChannelRepo.findOne({
      where: {
        chatId,
        isActive: true,
        role: In([MonitoredChannelRole.SOURCE, MonitoredChannelRole.BOTH]),
      },
    });
    if (!channel) return;

    // رسیدن پیام یعنی عضو هستیم -- مثلاً درخواست عضویت تازه تایید شده.
    if (!channel.isMember) {
      channel.isMember = true;
      channel.joinRequestPending = false;
      channel.joinedAt = channel.joinedAt ?? new Date();
      channel.lastError = null;
      channel.nextAttemptAt = null;
      await this.monitoredChannelRepo.save(channel);
    }

    const existing = await this.channelMessageRepo.findOne({ where: { chatId, messageId } });
    if (existing) return;

    this.recentMessageKeys.add(key);

    // پیام صوتی: اول به متن تبدیل می‌شه و بعد مثل پیام متنی بررسی می‌شه.
    const isVoice = !!voiceMessage;
    if (voiceMessage) {
      const audioAttr = voiceMessage.voice?.attributes.find(
        (attr): attr is Api.DocumentAttributeAudio => attr instanceof Api.DocumentAttributeAudio,
      );
      text = await this.speechToTextService.transcribeVoice(
        audioAttr?.duration ?? 0,
        async () => {
          const audio = await this.client!.downloadMedia(voiceMessage, {});
          if (!Buffer.isBuffer(audio)) throw new Error('فایل صوتی دانلود نشد.');
          return audio;
        },
        `telegram ${key}`,
      );
      if (!text) return;
    }

    await this.cargoPipeline.process({
      label: `telegram ${key}`,
      text,
      isVoice,
      entity: TelegramChannelMessage,
      record: { chatId, messageId },
      source: { platform: 'telegram', chatId },
    });
  }

  // ------------------------------------------------------------------
  // عضویت در گروه/کانال‌های ثبت‌شده در دیتابیس
  // ------------------------------------------------------------------

  @Cron('*/2 * * * *')
  async syncMonitoredChannels(): Promise<void> {
    if (!this.client || this.isSyncing) return;
    if (Date.now() < this.floodWaitUntil) return;

    this.isSyncing = true;
    try {
      await this.recheckPendingRequests();
      await this.joinNextChannel();
    } finally {
      this.isSyncing = false;
    }
  }

  // GramJS گاهی بعد از مدت طولانی بی‌کاری دریافت آپدیت‌های کانال رو متوقف
  // می‌کنه؛ یک درخواست سبک دوره‌ای اتصال آپدیت‌ها رو زنده نگه می‌داره.
  @Cron('*/5 * * * *')
  async keepUpdatesAlive(): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.invoke(new Api.updates.GetState());
    } catch (error) {
      this.logger.warn(`keep-alive تلگرام ناموفق بود: ${(error as Error).message}`);
    }
  }

  /** در هر اجرا حداکثر یک عضویت -- با فاصله‌ی تصادفی و سقف روزانه. */
  private async joinNextChannel(): Promise<void> {
    if (Date.now() < this.nextJoinAllowedAt) return;

    const attemptsLast24h = await this.monitoredChannelRepo.count({
      where: { lastJoinAttemptAt: MoreThanOrEqual(new Date(Date.now() - 24 * 60 * 60 * 1000)) },
    });
    if (attemptsLast24h >= TelegramChannelService.DAILY_JOIN_LIMIT) return;

    const now = new Date();
    const pendingFilter = {
      isActive: true,
      isMember: false,
      joinRequestPending: false,
      identifier: Not(IsNull()),
    };
    const channel = await this.monitoredChannelRepo.findOne({
      where: [
        { ...pendingFilter, nextAttemptAt: IsNull() },
        { ...pendingFilter, nextAttemptAt: LessThanOrEqual(now) },
      ],
      order: { createdAt: 'ASC' },
    });
    if (!channel) return;

    channel.lastJoinAttemptAt = now;
    this.nextJoinAllowedAt = Date.now() + this.randomJoinDelayMs();

    try {
      const result = await this.joinByIdentifier(channel.identifier!);
      await this.applyJoinResult(channel, result);
    } catch (error) {
      await this.handleJoinError(channel, error);
    }
  }

  /** درخواست‌های عضویتِ منتظر تایید رو بررسی می‌کنه (بدون فرستادن درخواست جدید). */
  private async recheckPendingRequests(): Promise<void> {
    const pending = await this.monitoredChannelRepo.find({
      where: {
        isActive: true,
        joinRequestPending: true,
        nextAttemptAt: LessThanOrEqual(new Date()),
      },
      take: 5,
    });

    for (const channel of pending) {
      try {
        const result = await this.checkMembership(channel.identifier!);
        if (result) {
          await this.applyJoinResult(channel, result);
        } else {
          channel.retryCount += 1;
          const minutes = exponentialBackoffMinutes(
            channel.retryCount,
            TelegramChannelService.PENDING_RECHECK_MINUTES,
            TelegramChannelService.PENDING_RECHECK_MAX_MINUTES,
          );
          channel.nextAttemptAt = new Date(Date.now() + minutes * 60_000);
          await this.monitoredChannelRepo.save(channel);
        }
      } catch (error) {
        await this.handleJoinError(channel, error);
        if (Date.now() < this.floodWaitUntil) return;
      }

      await sleep(randomBetween(3_000, 8_000));
    }
  }

  private async applyJoinResult(
    channel: TelegramMonitoredChannel,
    result: JoinResult,
  ): Promise<void> {
    if (result.chatId && result.chatId !== channel.chatId) {
      const duplicate = await this.monitoredChannelRepo.findOne({ where: { chatId: result.chatId } });
      if (duplicate && duplicate.id !== channel.id) {
        channel.isActive = false;
        channel.joinRequestPending = false;
        channel.nextAttemptAt = null;
        channel.lastError = `این گروه/کانال قبلاً با رکورد دیگه‌ای ثبت شده (${duplicate.identifier ?? duplicate.id}).`;
        await this.monitoredChannelRepo.save(channel);
        return;
      }
      channel.chatId = result.chatId;
    }

    channel.label = channel.label ?? result.title;
    if (result.type) channel.type = result.type;
    channel.lastError = null;
    channel.retryCount = 0;

    if (result.pending) {
      channel.isMember = false;
      channel.joinRequestPending = true;
      channel.nextAttemptAt = new Date(
        Date.now() + TelegramChannelService.PENDING_RECHECK_MINUTES * 60_000,
      );
      this.logger.log(`📨 درخواست عضویت فرستاده شد، منتظر تایید ادمین: ${channel.identifier}`);
    } else {
      channel.isMember = true;
      channel.joinRequestPending = false;
      channel.joinedAt = channel.joinedAt ?? new Date();
      channel.nextAttemptAt = null;
      this.logger.log(`✅ عضو گروه/کانال تلگرام شد: ${channel.chatId} (${channel.label ?? channel.identifier})`);
    }

    await this.monitoredChannelRepo.save(channel);
  }

  private async handleJoinError(channel: TelegramMonitoredChannel, error: unknown): Promise<void> {
    if (error instanceof FloodWaitError) {
      const waitMs = (error.seconds + randomBetween(30, 120)) * 1000;
      this.floodWaitUntil = Date.now() + waitMs;
      channel.nextAttemptAt = new Date(this.floodWaitUntil);
      channel.lastError = `FloodWait: تلگرام ${error.seconds} ثانیه محدودیت داد.`;
      await this.monitoredChannelRepo.save(channel);
      this.logger.warn(`⛔ FloodWait ${error.seconds} ثانیه -- همه‌ی عملیات عضویت تا اون موقع متوقف شد.`);
      return;
    }

    const code = error instanceof RPCError ? error.errorMessage : null;

    if (code === 'CHANNELS_TOO_MUCH') {
      this.floodWaitUntil = Date.now() + 24 * 60 * 60 * 1000;
      channel.nextAttemptAt = new Date(this.floodWaitUntil);
      channel.lastError = 'اکانت به سقف تعداد گروه/کانال تلگرام (۵۰۰) رسیده.';
      await this.monitoredChannelRepo.save(channel);
      this.logger.error(channel.lastError);
      return;
    }

    const permanentMessage =
      error instanceof PermanentJoinError
        ? error.message
        : code && PERMANENT_JOIN_ERRORS[code]
          ? PERMANENT_JOIN_ERRORS[code]
          : /No user has .* as username/i.test((error as Error)?.message ?? '')
            ? PERMANENT_JOIN_ERRORS.USERNAME_NOT_OCCUPIED
            : null;

    if (permanentMessage) {
      channel.isActive = false;
      channel.joinRequestPending = false;
      channel.nextAttemptAt = null;
      channel.lastError = permanentMessage;
      await this.monitoredChannelRepo.save(channel);
      this.logger.error(`عضویت ممکن نیست (${channel.identifier}): ${permanentMessage}`);
      return;
    }

    channel.retryCount += 1;
    channel.lastError = (error as Error)?.message ?? String(error);
    const backoffMinutes = exponentialBackoffMinutes(
      channel.retryCount,
      TelegramChannelService.BACKOFF_BASE_MINUTES,
      TelegramChannelService.BACKOFF_MAX_MINUTES,
    );
    channel.nextAttemptAt = new Date(Date.now() + backoffMinutes * 60_000);
    await this.monitoredChannelRepo.save(channel);

    this.logger.error(
      `عضویت ناموفق بود: ${channel.identifier} -- ${backoffMinutes} دقیقه‌ی دیگه دوباره تلاش می‌شه (تلاش #${channel.retryCount})`,
      error as Error,
    );
  }

  // ------------------------------------------------------------------
  // فراخوانی‌های تلگرام
  // ------------------------------------------------------------------

  private async joinByIdentifier(identifier: string): Promise<JoinResult> {
    const client = this.client!;
    const parsed = this.parseIdentifier(identifier);

    if (parsed.kind === 'invite') {
      const invite = await client.invoke(new Api.messages.CheckChatInvite({ hash: parsed.hash }));
      if (invite instanceof Api.ChatInviteAlready) {
        return this.fromChat(invite.chat, false);
      }

      const preview: JoinResult =
        invite instanceof Api.ChatInvite
          ? {
            chatId: null,
            title: invite.title,
            type: invite.broadcast ? MonitoredChatType.CHANNEL : MonitoredChatType.GROUP,
            pending: false,
          }
          : this.fromChat(invite.chat, false);

      // مثل کاربر واقعی: اول پیش‌نمایش، بعد چند ثانیه مکث، بعد عضویت.
      await sleep(randomBetween(3_000, 8_000));

      try {
        const updates = await client.invoke(new Api.messages.ImportChatInvite({ hash: parsed.hash }));
        const chat = this.firstChat(updates);
        if (chat) return this.fromChat(chat, false);
      } catch (error) {
        const code = error instanceof RPCError ? error.errorMessage : null;
        if (code === 'INVITE_REQUEST_SENT') return { ...preview, pending: true };
        if (code !== 'USER_ALREADY_PARTICIPANT') throw error;
      }

      // عضو هستیم ولی chatId تو جواب نبود -- از خود لینک می‌گیریم.
      const again = await client.invoke(new Api.messages.CheckChatInvite({ hash: parsed.hash }));
      if (again instanceof Api.ChatInviteAlready) return this.fromChat(again.chat, false);
      throw new Error('عضویت انجام شد ولی شناسه‌ی گروه/کانال به دست نیومد.');
    }

    const entity = await client.getEntity(parsed.username);
    if (!(entity instanceof Api.Channel)) {
      throw new PermanentJoinError('این آیدی مربوط به گروه/کانال نیست.');
    }

    await sleep(randomBetween(3_000, 8_000));

    try {
      await client.invoke(new Api.channels.JoinChannel({ channel: entity }));
    } catch (error) {
      const code = error instanceof RPCError ? error.errorMessage : null;
      if (code === 'INVITE_REQUEST_SENT') return this.fromChat(entity, true);
      if (code !== 'USER_ALREADY_PARTICIPANT') throw error;
    }

    return this.fromChat(entity, false);
  }

  /** اگه اکانت عضو شده باشه نتیجه‌ی عضویت رو برمی‌گردونه، وگرنه null. */
  private async checkMembership(identifier: string): Promise<JoinResult | null> {
    const client = this.client!;
    const parsed = this.parseIdentifier(identifier);

    if (parsed.kind === 'invite') {
      const invite = await client.invoke(new Api.messages.CheckChatInvite({ hash: parsed.hash }));
      return invite instanceof Api.ChatInviteAlready ? this.fromChat(invite.chat, false) : null;
    }

    const entity = await client.getEntity(parsed.username);
    if (!(entity instanceof Api.Channel)) return null;

    try {
      await client.invoke(
        new Api.channels.GetParticipant({ channel: entity, participant: new Api.InputPeerSelf() }),
      );
      return this.fromChat(entity, false);
    } catch (error) {
      if (error instanceof RPCError && error.errorMessage === 'USER_NOT_PARTICIPANT') return null;
      throw error;
    }
  }

  private firstChat(updates: Api.TypeUpdates): Api.TypeChat | null {
    if ('chats' in updates && updates.chats.length > 0) return updates.chats[0];
    return null;
  }

  private fromChat(chat: Api.TypeChat, pending: boolean): JoinResult {
    return {
      chatId: utils.getPeerId(chat),
      title: 'title' in chat ? chat.title : null,
      type:
        chat instanceof Api.Channel && chat.broadcast
          ? MonitoredChatType.CHANNEL
          : MonitoredChatType.GROUP,
      pending,
    };
  }

  /**
   * لینک خصوصی: t.me/+HASH، t.me/joinchat/HASH یا +HASH
   * لینک عمومی: t.me/username، @username یا username
   */
  private parseIdentifier(identifier: string): ParsedIdentifier {
    const value = identifier.trim();

    const invite = value.match(
      /^(?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.me|telegram\.dog)\/(?:\+|joinchat\/)([\w-]+)/i,
    );
    if (invite) return { kind: 'invite', hash: invite[1] };
    if (value.startsWith('+')) return { kind: 'invite', hash: value.slice(1) };

    const link = value.match(
      /^(?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.me|telegram\.dog)\/([A-Za-z][A-Za-z0-9_]{3,})/i,
    );
    if (link) return { kind: 'username', username: link[1] };

    const username = value.match(/^@?([A-Za-z][A-Za-z0-9_]{3,})$/);
    if (username) return { kind: 'username', username: username[1] };

    throw new PermanentJoinError('فرمت لینک نامعتبره.');
  }

  private randomJoinDelayMs(): number {
    return (
      (TelegramChannelService.JOIN_MIN_INTERVAL_MINUTES +
        Math.random() * TelegramChannelService.JOIN_JITTER_MINUTES) *
      60_000
    );
  }
}
