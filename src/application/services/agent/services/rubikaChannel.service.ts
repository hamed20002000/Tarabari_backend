import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { dirname, join } from 'node:path';
import { Client as RubikaClient } from 'rubjs';
import type { MessageType as RubikaMessage } from 'rubjs';
import { RubikaMonitoredChannel } from '../entities/RubikaMonitoredChannel';
import { RubikaChannelMessage } from '../entities/RubikaChannelMessage';
import { MessengerSession } from '../entities/MessengerSession';
import { MonitoredChatType } from '../types';
import { ChannelMembershipService } from './channelMembership.service';
import { SpeechToTextService } from './speechToText.service';
import { CargoPipelineService } from './cargoPipeline.service';
import {
  AccountChannelMonitor,
  JoinErrorDecision,
  JoinResult,
  PermanentJoinError,
} from './accountChannelMonitor';
import { randomBetween, sleep } from '../common/delay';

type ParsedIdentifier =
  | { kind: 'group-invite'; hash: string }
  | { kind: 'channel-invite'; hash: string }
  | { kind: 'username'; username: string };

// rubjs کلاس رمزنگاریش رو export نکرده (و exports پکیج مسیر داخلی رو می‌بنده) --
// از مسیر فایل خودش بارگذاری می‌شه.
type RubikaCryptoType = {
  passphrase(auth: string): string;
  decode_auth(auth: string): string;
  decrypt(dataEnc: string, key: Buffer): string;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const RubikaCrypto: RubikaCryptoType = require(join(dirname(require.resolve('rubjs')), 'core/client/crypto')).default;

// status_det هایی که یعنی نشست باطل شده (از دستگاه دیگه خارج شده) -- اتصال مجدد فایده نداره.
const INVALID_SESSION_STATUSES = ['INVALID_AUTH', 'NOT_REGISTERED'];

const PERMANENT_JOIN_STATUSES: Record<string, string> = {
  INVALID_INPUT: 'لینک روبیکا نامعتبر یا منقضی شده.',
  NOT_FOUND: 'گروه/کانالی با این لینک در روبیکا پیدا نشد.',
  INVALID_ACCESS: 'اکانت اجازه‌ی عضویت در این گروه/کانال رو نداره (احتمالاً حذف یا بن شده).',
};

const RECONNECT_BASE_DELAY_MS = 60_000;
const RECONNECT_MAX_DELAY_MS = 30 * 60_000;

/** خطای سمت سرور روبیکا با کد status_det -- rubjs خودش این کد رو دور می‌ریزه و فقط undefined برمی‌گردونه. */
class RubikaApiError extends Error {
  constructor(readonly status: string, readonly method: string) {
    super(`روبیکا ${method} رو رد کرد: ${status}`);
  }
}

/**
 * Client خود rubjs دو مشکل جدی برای سرور داره که اینجا جبران می‌شه:
 *   - سازنده start رو صدا می‌زنه و اگه getUserInfo به هر دلیلی (حتی قطعی
 *     موقت شبکه) ناموفق باشه، شماره رو از stdin می‌پرسه و تا ابد معطل می‌مونه.
 *   - کد خطای روبیکا (TOO_REQUESTS و ...) رو دور می‌ریزه؛ بدون اون نه
 *     محدودیت اکانت تشخیص داده می‌شه و نه لینک نامعتبر.
 */
class RubikaAccountClient extends RubikaClient {
  // جایگزین لاگین تعاملی rubjs -- لاگین با authenticate و بدون stdin انجام می‌شه.
  async start(): Promise<void> { }

  //#region ------------------- لاگین با نشست ذخیره‌شده (بدون stdin) -------------------
  async authenticate(): Promise<void> {
    const session = this.sessionDb.getSession() as { auth?: string; guid?: string; private_key?: string; agent?: string } | null;
    if (!session?.auth) throw new RubikaApiError('INVALID_AUTH', 'start');

    this.auth = session.auth;
    this.userGuid = session.guid;
    this.privateKey = session.private_key;
    if (session.agent) this.network.userAgent = session.agent;
    this.key = Buffer.from(RubikaCrypto.passphrase(this.auth), 'utf8');
    this.decode_auth = RubikaCrypto.decode_auth(this.auth);

    const me = await this.call<{ user: { user_guid: string } }>('getUserInfo', {});
    this.userGuid = me.user.user_guid;
    this.initialize = true;
  }
    //#endregion ----------------------------------------------------------------------


  /** مثل builder خود rubjs، ولی با خطای دارای کد به‌جای undefined. */
  
  //#region ---------------- یک wrapper عمومی برای API روبیکاست ------------------------
  async call<T = any>(method: string, input: Record<string, unknown>): Promise<T> {
    const response = await this.network.send({ method, input, tmp_session: false });
    if (!response) throw new RubikaApiError('NO_RESPONSE', method);

    const result = response.data_enc
      ? JSON.parse(RubikaCrypto.decrypt(response.data_enc, this.key!))
      : response;
    if (result.status === 'OK' && result.status_det === 'OK') return result.data as T;
    throw new RubikaApiError(String(result.status_det ?? result.status ?? 'UNKNOWN'), method);
  }
  //#endregion --------------------------------------------------------------------------
}

/**
 * گوش دادن به گروه/کانال‌های روبیکا با یک اکانت کاربری (rubjs -- API غیررسمی
 * وب روبیکا). منطق عضویت و پردازش پیام در AccountChannelMonitor مشترکه؛ اینجا
 * فقط اتصال و فراخوانی‌های خود روبیکا هست. اتصال مجدد websocket رو خود
 * rubjs انجام می‌ده؛ اتصال اولیه‌ی ناموفق اینجا با backoff دوباره تلاش می‌شه.
 */
@Injectable()
export class RubikaChannelService extends AccountChannelMonitor<RubikaMonitoredChannel, RubikaChannelMessage> {
  
  
  //#region --------------------- تعریف متغییرهای خصوصی -----------------------
  private client: RubikaAccountClient | null = null;
  private stopped = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  //#endregion -----------------------------------------------------------------

  constructor(
    @InjectRepository(RubikaMonitoredChannel)
    monitoredChannelRepo: Repository<RubikaMonitoredChannel>,
    @InjectRepository(RubikaChannelMessage)
    channelMessageRepo: Repository<RubikaChannelMessage>,
    @InjectRepository(MessengerSession)
    sessionRepo: Repository<MessengerSession>,
    cargoPipeline: CargoPipelineService,
    membership: ChannelMembershipService,
    speechToTextService: SpeechToTextService,
  ) {
    super('rubika', monitoredChannelRepo, channelMessageRepo, sessionRepo, cargoPipeline, membership, speechToTextService, {
      // کدهای خطای API غیررسمی روبیکا مستند نیست -- خطای ناشناخته‌ی تکراری ناموفق اعلام می‌شه.
      maxJoinAttempts: Number(process.env.RUBIKA_MAX_JOIN_ATTEMPTS) || 8,
    });
  }

  //#region ------------------------ آیا  اکانت روبیکا وصل هست ---------------------------
  protected get isConnected(): boolean {
    return !!this.client;
  }
  //#endregion ----------------------------------------------------------------------------


  //#region ------------------------ قطع اتصال از روبیکا ---------------------------
  protected async disconnect(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;

    const network = this.client?.network;
    this.client = null;
    if (!network) return;
    // reconnecting=true جلوی اتصال مجدد خودکار rubjs بعد از بستن رو می‌گیره.
    network.reconnecting = true;
    clearInterval(network.heartbeatInterval);
    clearTimeout(network.inactivityTimeout);
    network.ws?.close();
  }
  //#endregion ----------------------------------------------------------------------

  //#region ------------------------ اتصال به روبیکا با نشست ذخیره‌شده ---------------------------
  protected async connect(session: string): Promise<void> {
    // نشست همون خروجی رمزشده‌ی rubjs ({ iv, enData }) هست که اسکریپت لاگین ذخیره کرده.
    const client = new RubikaAccountClient(JSON.parse(session));

    try {
      await client.authenticate();
    } catch (error) {
      if (error instanceof RubikaApiError && INVALID_SESSION_STATUSES.includes(error.status)) {
        this.logger.error('نشست روبیکا نامعتبره (احتمالاً از دستگاه دیگه خارج شده) -- دوباره `npm run rubika:login` رو اجرا کنید.');
        return;
      }
      this.scheduleReconnect(session, error);
      return;
    }

    if (this.stopped) return;
    client.on('message', async (ctx) => this.onMessage(client, ctx));
    void client.run().catch((error) => this.logger.error('دریافت آپدیت‌های روبیکا متوقف شد', error as Error));

    this.client = client;
    this.reconnectAttempts = 0;
    this.logger.log(`اکانت روبیکا متصل شد: ${client.userGuid}`);
  }
  //#endregion ---------------------------------------------------------------------------------

  //#region ------------------------- اتصال اولیه ناموفق (شبکه، سرور روبیکا) -- با فاصله‌ی ۱، ۲، ۴ ... تا ۳۰ دقیقه دوباره تلاش می‌شه -----
  private scheduleReconnect(session: string, error: unknown): void {
    if (this.stopped) return;
    const delayMs = Math.min(RECONNECT_BASE_DELAY_MS * 2 ** this.reconnectAttempts, RECONNECT_MAX_DELAY_MS);
    this.reconnectAttempts += 1;
    this.logger.warn(
      `اتصال به روبیکا ناموفق بود (${(error as Error)?.message ?? error}) -- ${delayMs / 1000} ثانیه‌ی دیگه دوباره تلاش می‌شه (تلاش #${this.reconnectAttempts}).`,
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect(session).catch((err) => this.scheduleReconnect(session, err));
    }, delayMs);
  }
  //#endregion -------------------------------------------------------------------------------------------------------------------------

  //#region -------------------------- پردازش پیغام دریافتی ---------------------------------
  private onMessage(client: RubikaAccountClient, ctx: RubikaMessage): void {
    // g0 = گروه، c0 = کانال -- پیوی (u0) و ربات‌ها (b0) نادیده گرفته می‌شن.
    const chatId = ctx.object_guid;
    if (!chatId?.startsWith('g0') && !chatId?.startsWith('c0')) return;
    if (ctx.action && ctx.action !== 'New') return;

    const message = ctx.message;
    if (!message) return;

    // پیام سیستمی گروه: اگه اکانت ما حذف شده باشه، مثل واتساپ اعلام می‌شه.
    if (message.event_data) {
      const event = message.event_data as typeof message.event_data & { peer_objects?: { object_guid?: string }[] };
      if (
        event.type === 'RemoveGroupMembers' &&
        event.peer_objects?.some((peer) => peer.object_guid === client.userGuid)
      ) {
        void this.markRemoved(chatId, 'اکانت از گروه روبیکا حذف شد (kicked/removed).').catch((error) =>
          this.logger.error(`ثبت حذف از گروه روبیکا ناموفق بود: ${chatId}`, error as Error),
        );
      }
      return;
    }

    // پیام‌های خود اکانت (مثل outgoing تلگرام) بررسی نمی‌شن.
    if (message.author_object_guid && message.author_object_guid === client.userGuid) return;

    const text = (message.text ?? '').trim();
    const file = message.file_inline;
    const isVoice = !text && file?.type === 'Voice';
    if (!text && !isVoice) return;

    this.enqueueMessage({
      chatId,
      messageId: String(ctx.message_id),
      text,
      voice: isVoice
        ? {
          // مدت فایل‌های صوتی روبیکا (time) به میلی‌ثانیه‌ست.
          durationSeconds: Math.round((file.time ?? 0) / 1000),
          download: async () => {
            const audio: Buffer = await client.download(file);
            // rubjs با خطای یک تکه، بی‌صدا فایل نصفه برمی‌گردونه.
            if (!audio?.length || (file.size && audio.length < file.size)) {
              throw new Error('فایل صوتی روبیکا کامل دانلود نشد.');
            }
            return audio;
          },
        }
        : undefined,
    });
  }
  //#endregion -------------------------------------------------------------------------------

  //#region -------------------------- مشخص کردن نوع خطا هنگام عضویت --------------------------
  protected classifyJoinError(error: unknown): JoinErrorDecision {
    const status = error instanceof RubikaApiError ? error.status : '';
    const message = (error as Error)?.message ?? '';

    if (/TOO_REQUESTS|TOO_MANY|FLOOD/i.test(status || message)) {
      return { kind: 'pause', seconds: 60 * 60 + randomBetween(60, 300), reason: `روبیکا محدودیت درخواست داد: ${message}` };
    }
    if (INVALID_SESSION_STATUSES.includes(status)) {
      return {
        kind: 'pause',
        seconds: 6 * 60 * 60,
        reason: 'نشست روبیکا باطل شده -- دوباره `npm run rubika:login` رو اجرا کنید و برنامه رو ری‌استارت کنید.',
      };
    }
    if (PERMANENT_JOIN_STATUSES[status]) {
      return { kind: 'permanent', reason: PERMANENT_JOIN_STATUSES[status] };
    }
    return { kind: 'retry' };
  }
  //#endregion ---------------------------------------------------------------------------------

  
  //#region ---------------------------- تابع جوین ---------------------------------------------
  protected async join(identifier: string): Promise<JoinResult> {
    const client = this.client!;
    const parsed = RubikaChannelService.parseIdentifier(identifier);

    // مثل کاربر واقعی: اول پیش‌نمایش لینک، بعد چند ثانیه مکث، بعد عضویت.
    const preview = await this.preview(parsed);
    await sleep(randomBetween(3_000, 8_000));

    if (parsed.kind === 'username') {
      await client.call('joinChannelAction', { channel_guid: preview.chatId, action: 'Join' });
      return preview;
    }

    const result = await client.call<any>(
      parsed.kind === 'group-invite' ? 'joinGroup' : 'joinChannelByLink',
      { hash_link: parsed.hash },
    );
    const chatId: string | undefined = result?.group?.group_guid ?? result?.channel?.channel_guid;
    if (chatId) return { ...preview, chatId };

    // جواب موفق بدون گروه/کانال = درخواست عضویت برای تایید ادمین ثبت شده.
    // درخواست دوباره فرستاده نمی‌شه؛ checkMembership بعداً عضویت رو بررسی می‌کنه.
    this.logger.warn(`جواب عضویت روبیکا بدون شناسه‌ی گروه/کانال بود: ${JSON.stringify(result)?.slice(0, 500)}`);
    return { ...preview, pending: true };
  }
  //#endregion ----------------------------------------------------------------------------------

  //#region ---------------------------- بررسی اینکه اکلنت روبیکا عضو کانال یا گروه هست یا نه-----
  protected async checkMembership(identifier: string): Promise<JoinResult | null> {
    const client = this.client!;
    const preview = await this.preview(RubikaChannelService.parseIdentifier(identifier));

    const isGroup = preview.type === MonitoredChatType.GROUP;
    const info = await client
      .call<any>(isGroup ? 'getGroupInfo' : 'getChannelInfo', isGroup ? { group_guid: preview.chatId } : { channel_guid: preview.chatId })
      .catch((error) => {
        // بدون عضویت، روبیکا ممکنه اطلاعات گروه خصوصی رو اصلاً نده.
        if (error instanceof RubikaApiError && error.status === 'INVALID_ACCESS') return null;
        throw error;
      });

    // گفتگو (chat) فقط وقتی برمی‌گرده که گروه/کانال در لیست گفتگوهای اکانت باشه، یعنی عضویم.
    return info?.chat ? preview : null;
  }
  //#endregion --------------------------------------------------------------------------------------

  //#region ------------------------ شناسه، اسم و نوع گروه/کانال رو بدون عضویت پیدا می‌کنه. ---------
  private async preview(parsed: ParsedIdentifier): Promise<JoinResult> {
    const client = this.client!;

    if (parsed.kind === 'username') {
      const found = await client.call<any>('getObjectByUsername', { username: parsed.username });
      if (!found?.exist) throw new PermanentJoinError('گروه/کانالی با این آیدی در روبیکا پیدا نشد.');
      if (!found.channel?.channel_guid) throw new PermanentJoinError('این آیدی مربوط به کانال نیست.');
      return this.channelResult(found.channel);
    }

    if (parsed.kind === 'group-invite') {
      const result = await client.call<any>('groupPreviewByJoinLink', { hash_link: parsed.hash });
      if (result?.is_valid === false || !result?.group?.group_guid) {
        throw new PermanentJoinError('لینک دعوت گروه روبیکا نامعتبر یا منقضی شده.');
      }
      return {
        chatId: result.group.group_guid,
        title: result.group.group_title ?? null,
        type: MonitoredChatType.GROUP,
        pending: false,
      };
    }

    const result = await client.call<any>('channelPreviewByJoinLink', { hash_link: parsed.hash });
    if (result?.is_valid === false || !result?.channel?.channel_guid) {
      throw new PermanentJoinError('لینک دعوت کانال روبیکا نامعتبر یا منقضی شده.');
    }
    return this.channelResult(result.channel);
  }
  //#endregion ---------------------------------------------------------------------------------

  //#region ------------------------- همون applyJoinResult -------------------------------------
  private channelResult(channel: { channel_guid: string; channel_title?: string }): JoinResult {
    return {
      chatId: channel.channel_guid,
      title: channel.channel_title ?? null,
      type: MonitoredChatType.CHANNEL,
      pending: false,
    };
  }
  //#endregion ---------------------------------------------------------------------------------

  /**
   * لینک خصوصی گروه: rubika.ir/joing/HASH، کانال: rubika.ir/joinc/HASH
   * لینک عمومی: rubika.ir/username
   * (@username به‌تنهایی آیدی تلگرام حساب می‌شه، برای همین دامنه‌ی rubika.ir الزامیه.)
   */
  static parseIdentifier(identifier: string): ParsedIdentifier {
    const value = identifier.trim();

    const invite = value.match(/^(?:https?:\/\/)?(?:www\.)?rubika\.ir\/(joing|joinc)\/([\w-]+)/i);
    if (invite) {
      return { kind: invite[1].toLowerCase() === 'joing' ? 'group-invite' : 'channel-invite', hash: invite[2] };
    }

    const link = value.match(/^(?:https?:\/\/)?(?:www\.)?rubika\.ir\/@?([A-Za-z][A-Za-z0-9_]{3,})\/?$/i);
    if (link) return { kind: 'username', username: link[1] };

    throw new PermanentJoinError('فرمت لینک روبیکا نامعتبره.');
  }

  /** شکل یکتای لینک برای ذخیره در identifier؛ لینکی که مال روبیکا نیست = null. */
  static normalizeIdentifier(identifier: string): string | null {
    try {
      const parsed = RubikaChannelService.parseIdentifier(identifier);
      if (parsed.kind === 'username') return `https://rubika.ir/${parsed.username.toLowerCase()}`;
      return `https://rubika.ir/${parsed.kind === 'group-invite' ? 'joing' : 'joinc'}/${parsed.hash}`;
    } catch {
      return null;
    }
  }
}
