import { Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import {
  DeepPartial,
  EntityTarget,
  FindOptionsOrder,
  FindOptionsSelect,
  FindOptionsWhere,
  In,
  IsNull,
  LessThanOrEqual,
  MoreThanOrEqual,
  Not,
  Repository,
} from 'typeorm';
import { AccountChannelMessageBase, AccountMonitoredChannelBase } from '../entities/AccountChannelBase';
import { MessengerSession } from '../entities/MessengerSession';
import { ChannelMembershipStatus, MonitoredChannelRole, MonitoredChatType } from '../types';
import { ChannelMembershipService } from './channelMembership.service';
import { SpeechToTextService } from './speechToText.service';
import { CargoPipelineService } from './cargoPipeline.service';
import { SerialTaskQueue } from '../common/serialTaskQueue';
import { RecentIdCache } from '../common/recentIdCache';
import { exponentialBackoffMinutes } from '../common/backoff';
import { AccountPlatform, isChannelMonitoringEnabled } from '../common/channelMonitoring';
import { randomBetween, sleep } from '../common/delay';
import { addChannelOwner, HAS_OWNERS } from '../common/channelOwners';

export interface JoinResult {
  chatId: string | null;
  title: string | null;
  type: MonitoredChatType | null;
  pending: boolean;
}

/** پیام دریافتی از یک گروه/کانال، مستقل از پلتفرم. */
export interface IncomingChatMessage {
  chatId: string;
  messageId: string | number;
  text: string;
  // پیام صوتی: فایل فقط موقع پردازش (داخل صف) دانلود می‌شه.
  voice?: { durationSeconds: number; download: () => Promise<Buffer> };
}

/**
 * برداشت هر پلتفرم از یک خطای عضویت:
 *   pause     -- محدودیت کل اکانت (FloodWait و ...): همه‌ی عضویت‌ها تا اون موقع متوقف می‌شن
 *   permanent -- با تلاش دوباره درست نمی‌شه: رکورد غیرفعال و «ناموفق» اعلام می‌شه
 *   retry     -- خطای موقت: با backoff دوباره تلاش می‌شه
 */
export type JoinErrorDecision =
  | { kind: 'pause'; seconds: number; reason: string }
  | { kind: 'permanent'; reason: string }
  | { kind: 'retry' };

// خطاهایی که با تلاش دوباره درست نمی‌شن -- رکورد غیرفعال می‌شه تا مدیر لینک رو اصلاح کنه.
export class PermanentJoinError extends Error { }

export interface JoinPolicy {
  joinMinIntervalMinutes: number;
  joinJitterMinutes: number;
  dailyJoinLimit: number;
  pendingRecheckMinutes: number;
  pendingRecheckMaxMinutes: number;
  // رد شدن درخواست عضویت معمولاً اعلام نمی‌شه (از بیرون با «هنوز منتظر»
  // فرقی نداره) -- درخواستی که تا این مدت تایید نشه، رد‌شده حساب می‌شه.
  joinRequestMaxDays: number;
  backoffBaseMinutes: number;
  backoffMaxMinutes: number;
  // بعد از این تعداد خطای موقت پشت‌سرهم عضویت ناموفق اعلام می‌شه؛ null یعنی بی‌نهایت.
  maxJoinAttempts: number | null;
}

/** پیش‌فرض‌ها + override از env با پیشوند اسم پلتفرم (مثلاً BALE_DAILY_JOIN_LIMIT). */
function joinPolicyFor(platform: AccountPlatform, overrides: Partial<JoinPolicy>): JoinPolicy {
  const env = (name: string) => Number(process.env[`${platform.toUpperCase()}_${name}`]) || undefined;
  return {
    joinJitterMinutes: 10,
    pendingRecheckMinutes: 30,
    pendingRecheckMaxMinutes: 24 * 60,
    backoffBaseMinutes: 15,
    backoffMaxMinutes: 6 * 60,
    maxJoinAttempts: null,
    ...overrides,
    joinMinIntervalMinutes: env('JOIN_MIN_INTERVAL_MINUTES') ?? overrides.joinMinIntervalMinutes ?? 10,
    dailyJoinLimit: env('DAILY_JOIN_LIMIT') ?? overrides.dailyJoinLimit ?? 20,
    joinRequestMaxDays: env('JOIN_REQUEST_MAX_DAYS') ?? overrides.joinRequestMaxDays ?? 7,
  };
}

/**
 * منطق مشترک گوش دادن به گروه/کانال‌ها با یک اکانت کاربری (تلگرام، بله،
 * روبیکا): عضویت با لینک‌های ثبت‌شده در دیتابیس، پیگیری درخواست‌های عضویت،
 * اعلام وضعیت عضویت، و پردازش پیام‌ها (تشخیص بار + Outbox). هر پلتفرم فقط
 * اتصال، دریافت پیام، عضویت و ترجمه‌ی خطاهاش رو پیاده می‌کنه.
 *
 * ملاحظات ضد بن:
 *   - اکانت فقط می‌خونه؛ هیچ پیامی از این اکانت فرستاده نمی‌شه.
 *   - عضویت‌ها یکی‌یکی و با فاصله‌ی تصادفی (پیش‌فرض ۱۰ تا ۲۰ دقیقه) انجام می‌شن.
 *   - سقف روزانه برای تلاش‌های عضویت (پیش‌فرض ۲۰).
 *   - با محدودیت اکانت (pause)، کل عملیات عضویت تا پایان زمان انتظار متوقف می‌شه.
 *   - هر لینک فقط یک بار resolve می‌شه و بعدش chatId ذخیره می‌شه.
 */
export abstract class AccountChannelMonitor<
  C extends AccountMonitoredChannelBase,
  M extends AccountChannelMessageBase,
> implements OnModuleInit, OnModuleDestroy {
  protected readonly logger = new Logger(this.constructor.name);
  private readonly policy: JoinPolicy;

  private readonly messageQueue = new SerialTaskQueue();

  // کلید `${chatId}:${messageId}` -- جلوی فرستادن دوباره‌ی پیام‌های غیربارِ
  // تکراری به مدل رو می‌گیره (چون این‌ها توی دیتابیس ذخیره نمی‌شن).
  private readonly recentMessageKeys = new RecentIdCache(1000);

  // بعد از هر ری‌استارت هم چند دقیقه صبر می‌کنیم تا عضویت‌ها پشت‌سرهم نشن.
  private nextJoinAllowedAt = Date.now() + randomBetween(2, 5) * 60_000;
  private pausedUntil = 0;
  private isSyncing = false;

  protected constructor(
    protected readonly platform: AccountPlatform,
    protected readonly channelRepo: Repository<C>,
    private readonly messageRepo: Repository<M>,
    private readonly sessionRepo: Repository<MessengerSession>,
    private readonly cargoPipeline: CargoPipelineService,
    private readonly membership: ChannelMembershipService,
    private readonly speechToText: SpeechToTextService,
    policy: Partial<JoinPolicy> = {},
  ) {
    this.policy = joinPolicyFor(platform, policy);
  }

   //#region -------------------- بخش هایی که هر سرویس بابید خودش پیاده سازی کنه --------------

  protected abstract connect(session: string): Promise<void>;//با نشست ذخیره‌شده وصل می‌شه و شنونده‌ی پیام‌ها رو (با enqueueMessage) ثبت می‌کنه. 

  protected abstract disconnect(): Promise<void>;//بخش مربوط به اتصال رو می‌بنده و شنونده‌ی پیام‌ها رو لغو می‌کنه.

  protected abstract get isConnected(): boolean;//تا وقتی false باشه، cron عضویت کاری نمی‌کنه.

  protected abstract join(identifier: string): Promise<JoinResult>;//عضویت با لینک (یا ارسال درخواست عضویت اگه تایید ادمین لازم باشه). 

  protected abstract classifyJoinError(error: unknown): JoinErrorDecision;//خطای عضویت رو به تصمیم مشترک ترجمه می‌کنه (PermanentJoinError از قبل پوشش داده شده).

  protected checkMembership?(identifier: string): Promise<JoinResult | null>;//بررسی وضعیت عضویت بدون ارسال درخواست جدید (برای پلتفرم‌هایی که درخواست عضویت دارن).

//#endregion ------------------------------------------------------------------------------------

  onModuleInit() {
    // اتصال نباید بالا اومدن کل برنامه رو معطل کنه.
    void this.start();
  }

  async onModuleDestroy() {
    await this.disconnect().catch(() => undefined);
  }

  private async start(): Promise<void> {

    //#region -------------------- بررسی اینکه آیا سرویس فعال است یا نه --------------
    if (!isChannelMonitoringEnabled(this.platform)) {
      this.logger.warn(`${this.platform} در CHANNEL_MONITORING_ENABLED نیست -- عضویت و گوش دادن به گروه/کانال‌هاش غیرفعاله.`);
      return;
    }
    //#endregion -----------------------------------------------------------------------

    // کل بدنه داخل try -- start با void صدا زده می‌شه و خطای بیرون از try
    // (مثلاً قطعی لحظه‌ای دیتابیس) unhandled rejection می‌شد و پروسه رو می‌بست.
    try {

      //#region -------------------- بررسی اینکه آیا قبل به اکانت لاگین شدیم یا نه--------
      const stored = await this.sessionRepo.findOne({ where: { sessionId: this.platform } });
      if (!stored) {
        this.logger.warn(`نشست ${this.platform} پیدا نشد -- یک بار \`npm run ${this.platform}:login\` رو اجرا کنید.`);
        return;
      }
      //#endregion -----------------------------------------------------------------------

      //#region -------------------- اتصال به اکانت با نشست ذخیره‌شده --------------
      await this.connect(stored.session);
      //#endregion ----------------------------------------------------------------
    } catch (error) {
      this.logger.error(`اتصال به ${this.platform} ناموفق بود`, error as Error);
    }
  }

  //#region ------------------------ اگه نشست بعد از اتصال عوض شده باشه (مثلاً تمدید توکن)، نسخه‌ی جدید ذخیره می‌شه. ------
  protected async updateSession(session: string): Promise<void> {
    await this.sessionRepo.update({ sessionId: this.platform }, { session });
  }
  //#endregion -----------------------------------------------------------------------------------------------------------


  //#region -------------------- صف بندی کردن عملیات برای کروه ها و کانال ها --------------
  protected enqueueMessage(message: IncomingChatMessage): void {
    void this.messageQueue.run(() => this.handleChatMessage(message)).catch((error) =>
      this.logger.error(`خطا در پردازش پیام گروه/کانال ${this.platform}: ${message.chatId}`, error as Error),
    );
  }
  //#endregion -----------------------------------------------------------------------------

 

  //#region -------------------- پردازش یک پیام جدید از گروه یا کانال: تشخیص سفارش بار، و فقط برای سفارش
  //بار -- ذخیره در دیتابیس و انتشار event (cargo.message.detected) از طریق 
  // Outbox Pattern برای توزیع‌کننده. --------------
  private async handleChatMessage({ chatId, messageId, text, voice }: IncomingChatMessage): Promise<void> {
    
    //#region --------------------  جلوگیری از ارسال پیام های تکراری --------------
    const key = `${chatId}:${messageId}`;
    const label = `${this.platform} ${key}`;

    if (this.recentMessageKeys.has(key)) return;
    //#endregion ------------------------------------------------------------------------------
   

    // فقط از گروه/کانال‌هایی که به‌عنوان منبع ثبت و فعال شدن پیام می‌خونیم.

    //#region --------------------   فقط از گروه/کانال‌هایی که به‌عنوان منبع ثبت و فعال شدن پیام می‌خونیم و مخصوص همون سرویس یعنی تلگرام بله روبیکا --------------
    const channel = await this.channelRepo.findOne({
      where: {
        chatId,
        isActive: true,
        role: In([MonitoredChannelRole.SOURCE, MonitoredChannelRole.BOTH]),
      } as FindOptionsWhere<C>,
    });
    if (!channel) return;
    //#endregion ------------------------------------------------------------------------------


    // رسیدن پیام یعنی عضو هستیم -- مثلاً درخواست عضویت تازه تایید شده.

    //#region --------------------   بررسی عضویت در گروه/کانال چون وقتی پیغام میاد یعنی عضو شدیم برای کانال و گروه هایی هنوز تاپید عضویت نشدیم --------------
    if (!channel.isMember) {
      channel.isMember = true;
      channel.joinRequestPending = false;
      channel.joinedAt = channel.joinedAt ?? new Date();
      channel.lastError = null;
      channel.nextAttemptAt = null;
      await this.membership.transition(this.platform, channel, ChannelMembershipStatus.JOINED);
    }
    //#endregion ------------------------------------------------------------------------------

    // همه‌ی ثبت‌کننده‌ها حذفش کردن -- بار برای کسی نیست، فرستادن به مدل هزینه‌ی بی‌فایده‌ست.
    if (channel.ownerUserIds.length === 0) return;

    //#region --------------------   بررسی اینکه آیا پیام تکراری هست یا نه --------------
    const existing = await this.messageRepo.findOne({ where: { chatId, messageId } as FindOptionsWhere<M> });
    if (existing) return;
    //#endregion ------------------------------------------------------------------------------


    this.recentMessageKeys.add(key);//ذخیره کلید پیام در recentMessageKeys تا جلوی پردازش دوباره‌ی پیام‌های غیربارِ تکراری گرفته بشه.

    //#region --------------------   پیام صوتی: اول به متن تبدیل می‌شه و بعد مثل پیام متنی بررسی می‌شه --------------
    if (voice) {
      text = await this.speechToText.transcribeVoice(voice.durationSeconds, voice.download, label);
      if (!text) return;
    }
    //#endregion ------------------------------------------------------------------------------


    //#region --------------------   پردازش پیام: تشخیص بار و انتشار event (cargo.message.detected) --------------
    await this.cargoPipeline.process({
      label,
      text,
      isVoice: !!voice,
      entity: this.messageRepo.target as EntityTarget<M>,
      record: { chatId, messageId } as DeepPartial<M>,
      source: { platform: this.platform, chatId },
      ownerUserIds: channel.ownerUserIds,
    });
    //#endregion ------------------------------------------------------------------------------
  }
  //#endregion ------------------------------------------------------------------------------


  //#region --------------------  cron برای بررسی گروه/کانال‌های ثبت‌شده و عضویت با لینک‌ها --------------
  @Cron('*/2 * * * *')
  async syncMonitoredChannels(): Promise<void> {
    if (!this.isConnected || this.isSyncing) return;
    if (Date.now() < this.pausedUntil) return;

    this.isSyncing = true;
    try {
      await this.recheckPendingRequests();
      await this.joinNextChannel();
    } finally {
      this.isSyncing = false;
    }
  }
  //#endregion ------------------------------------------------------------------------------

  //#region --------------------  در هر اجرا حداکثر یک عضویت -- با فاصله‌ی تصادفی و سقف روزانه. --------
  private async joinNextChannel(): Promise<void> {

    //#region --------------------   بررسی زمان اجازه‌ی عضویت بعدی جهت جلوگیری از مسدود شدن--------------
     if (Date.now() < this.nextJoinAllowedAt) return;
    //#endregion ------------------------------------------------------------------------------

    //#region --------------------  بررسی تعداد تلاش‌های عضویت در ۲۴ ساعت گذشته جهت جلوگیری از مسدود شدن--------------
    const attemptsLast24h = await this.channelRepo.count({
      where: { lastJoinAttemptAt: MoreThanOrEqual(new Date(Date.now() - 24 * 60 * 60 * 1000)) } as FindOptionsWhere<C>,
    });
    if (attemptsLast24h >= this.policy.dailyJoinLimit) return;

    //#endregion ------------------------------------------------------------------------------

    const now = new Date();

    //#region -------------------- شرایط لازم برای تشخیص گروه/کانال‌های قابل عضویت --------------
    const pendingFilter = {
      isActive: true,
      isMember: false,
      joinRequestPending: false,
      identifier: Not(IsNull()),
      // رکوردی که همه‌ی ثبت‌کننده‌هاش حذفش کردن -- عضویت بی‌دلیل (ریسک بن، مصرف سقف روزانه).
      // با ثبت دوباره‌ی لینک، ثبت‌کننده اضافه می‌شه و خودبه‌خود دوباره در صف قرار می‌گیره.
      ownerUserIds: HAS_OWNERS,
    };
    //#endregion ------------------------------------------------------------------------------

    //#region --------------------  پیدا کردن گروه/کانال‌های قابل عضویت و تلاش برای عضویت --------------
    const channel = await this.channelRepo.findOne({
      where: [
        { ...pendingFilter, nextAttemptAt: IsNull() },
        { ...pendingFilter, nextAttemptAt: LessThanOrEqual(now) },
      ] as FindOptionsWhere<C>[],
      order: { createdAt: 'ASC' } as FindOptionsOrder<C>,
    });
    if (!channel) return;
    //#endregion ------------------------------------------------------------------------------


    //#region --------------------  ثبت زمان آخرین تلاش عضویت و زمان اجازه‌ی عضویت بعدی جهت جلوگیری از مسدود شدن --------------

    channel.lastJoinAttemptAt = now;
    this.nextJoinAllowedAt =
      Date.now() + (this.policy.joinMinIntervalMinutes + Math.random() * this.policy.joinJitterMinutes) * 60_000;
    //#endregion ------------------------------------------------------------------------------
   
    try {
      const result = await this.join(channel.identifier!);//عضویت با لینک (یا ارسال درخواست عضویت اگه تایید ادمین لازم باشه).
      await this.applyJoinResult(channel, result);
    } catch (error) {
      await this.handleJoinError(channel, error);
    }
  }
  //#endregion ----------------------------------------------------------------------------------------

  //#region --------------- درخواست‌های عضویتِ منتظر تایید رو بررسی می‌کنه (بدون فرستادن درخواست جدید).  ----------
  private async recheckPendingRequests(): Promise<void> {
    const pending = await this.channelRepo.find({
      where: {
        isActive: true,
        joinRequestPending: true,
        nextAttemptAt: LessThanOrEqual(new Date()),
        ownerUserIds: HAS_OWNERS,
      } as FindOptionsWhere<C>,
      take: 5,
    });

    for (const channel of pending) {
      const requestedAt = channel.lastJoinAttemptAt?.getTime() ?? Date.now();
      if (Date.now() - requestedAt > this.policy.joinRequestMaxDays * 24 * 60 * 60_000) {
        await this.markFailed(
          channel,
          `درخواست عضویت ظرف ${this.policy.joinRequestMaxDays} روز توسط ادمین گروه/کانال تایید نشد.`,
        );
        continue;
      }

      try {
        const result = (await this.checkMembership?.(channel.identifier!)) ?? null;
        if (result) {
          await this.applyJoinResult(channel, result);
        } else {
          channel.retryCount += 1;
          const minutes = exponentialBackoffMinutes(
            channel.retryCount,
            this.policy.pendingRecheckMinutes,
            this.policy.pendingRecheckMaxMinutes,
          );
          channel.nextAttemptAt = new Date(Date.now() + minutes * 60_000);
          await this.channelRepo.save(channel);
        }
      } catch (error) {
        await this.handleJoinError(channel, error);
        if (Date.now() < this.pausedUntil) return;
      }

      await sleep(randomBetween(3_000, 8_000));
    }
  }
  //#endregion --------------------------------------------------------------------------------------

  /**
   * channel قبل از درخواست به پیام‌رسان (که چند ثانیه طول می‌کشه) خونده شده و
   * save همه‌ی ستون‌های متفاوت رو می‌نویسه -- با ownerUserIds قدیمی، شرکتی که
   * این وسط همین لینک رو ثبت کرده بود پاک می‌شد. (رکورد از برنامه حذف نمی‌شه،
   * فقط ثبت‌کننده‌هاش کم و زیاد می‌شن.)
   */
  private async refreshOwners(channel: C): Promise<void> {
    const current = await this.channelRepo.findOne({
      where: { id: channel.id } as FindOptionsWhere<C>,
      select: { id: true, ownerUserIds: true } as FindOptionsSelect<C>,
    });
    if (current) channel.ownerUserIds = current.ownerUserIds;
  }

  //#region ------------------------- آماده سازی نتیجه جوین شدن و اطلاع به کاربر ----------------
  private async applyJoinResult(channel: C, result: JoinResult): Promise<void> {
    await this.refreshOwners(channel);

    if (result.chatId) {
      // رکورد دیگه‌ای (غیر از همین) با همین شناسه؟ -- یعنی همون گروه/کانال با لینک دیگه‌ای ثبت شده.
      const duplicate = await this.channelRepo.findOne({
        where: { chatId: result.chatId, id: Not(channel.id) } as FindOptionsWhere<C>,
      });
      if (duplicate) {
        // همون گروه/کانال با لینک دیگه‌ای ثبت شده -- ثبت‌کننده‌های این رکورد
        // به رکورد اصلی منتقل می‌شن تا اعلان‌ها براشون قطع نشه.
        const thisLinkOwners = channel.ownerUserIds;
        // اضافه کردن اتمیک -- ثبت هم‌زمان از API روی رکورد اصلی رو بازنویسی نمی‌کنه.
        const movedOwners: string[] = [];
        for (const userId of thisLinkOwners) {
          if (await addChannelOwner(this.channelRepo, duplicate.id, userId)) movedOwners.push(userId);
        }
        if (movedOwners.length > 0) {
          duplicate.ownerUserIds = [...duplicate.ownerUserIds, ...movedOwners];
          // وضعیت رکورد اصلی (مثلاً «عضو شد») به کاربرهای منتقل‌شده اعلام می‌شه.
          await this.membership.announce(this.platform, duplicate, movedOwners);
        }
        // ثبت‌کننده‌ها منتقل شدن -- این رکورد دیگه در لیست هیچ کاربری نمیاد.
        // ولی باید به ثبت‌کننده‌هاش اعلام بشه، وگرنه پنل‌شون همچنان «در صف» نشونش می‌ده
        // (مخصوصاً وقتی خودشون رکورد اصلی رو هم ثبت کرده بودن و announce بالا چیزی نفرستاده).
        channel.ownerUserIds = [];
        // ثبت بعدیِ همین لینک از API مستقیم به رکورد اصلی اضافه می‌شه (registerExisting).
        channel.mergedIntoId = duplicate.id;
        channel.isActive = false;
        channel.joinRequestPending = false;
        channel.nextAttemptAt = null;
        // اسم/لینک رکورد اصلی عمداً نمیاد -- ممکنه مال شرکت دیگه‌ای باشه (برچسب خودش یا لینک دعوت خصوصی).
        channel.lastError =
          'این لینک مال گروه/کانالیه که قبلاً با لینک دیگه‌ای ثبت شده؛ بارهاش از همون ثبت قبلی برای شما هم ارسال می‌شه.';
        await this.membership.transition(
          this.platform,
          channel,
          ChannelMembershipStatus.FAILED,
          channel.lastError,
          thisLinkOwners,
        );
        return;
      }
      channel.chatId = result.chatId;
      // رکوردی که قبلاً ادغام شده بود و دوباره فعال و عضو شد (مثلاً رکورد اصلی حذف شده) -- دیگه ادغام‌شده نیست.
      channel.mergedIntoId = null;
    }

    channel.label = channel.label ?? result.title;
    if (result.type) channel.type = result.type;
    channel.lastError = null;
    channel.retryCount = 0;

    if (result.pending) {
      channel.isMember = false;
      channel.joinRequestPending = true;
      channel.nextAttemptAt = new Date(Date.now() + this.policy.pendingRecheckMinutes * 60_000);
      this.logger.log(`📨 درخواست عضویت فرستاده شد، منتظر تایید ادمین: ${channel.identifier}`);
      await this.membership.transition(this.platform, channel, ChannelMembershipStatus.PENDING);
    } else {
      channel.isMember = true;
      channel.joinRequestPending = false;
      channel.joinedAt = channel.joinedAt ?? new Date();
      channel.nextAttemptAt = null;
      this.logger.log(`✅ عضو گروه/کانال ${this.platform} شد: ${channel.chatId} (${channel.label ?? channel.identifier})`);
      await this.membership.transition(this.platform, channel, ChannelMembershipStatus.JOINED);
    }
  }
  //#endregion ----------------------------------------------------------------------------------
  
  //#region ---------------     اکانت از گروه/کانال حذف (kick/ban) شد -- مثل واتساپ رکورد غیرفعال و به ثبت‌کننده‌ها اعلام می‌شه؛ با فعال‌سازی دوباره از پنل، از اول عضو می‌شه. --
  protected async markRemoved(chatId: string, reason: string): Promise<void> {
    const channels = await this.channelRepo.find({ where: { chatId, isMember: true } as FindOptionsWhere<C> });
    for (const channel of channels) {
      channel.isActive = false;
      channel.isMember = false;
      channel.joinRequestPending = false;
      channel.nextAttemptAt = null;
      channel.lastError = reason;
      await this.membership.transition(this.platform, channel, ChannelMembershipStatus.REMOVED, reason);
      this.logger.warn(`🚫 اکانت ${this.platform} از گروه/کانال حذف شد: ${chatId} (${channel.label ?? channel.identifier})`);
    }
  }
  //#endregion -------------------------------------------------------------------------------------------------------------------------------------------------------------

  
  //#region ------------------- عضویت ممکن نیست -- رکورد غیرفعال می‌شه و به ثبت‌کننده‌ها اعلام می‌شه. -------------
  private async markFailed(channel: C, reason: string): Promise<void> {
    channel.isActive = false;
    channel.joinRequestPending = false;
    channel.nextAttemptAt = null;
    channel.lastError = reason;
    await this.membership.transition(this.platform, channel, ChannelMembershipStatus.FAILED, reason);
    this.logger.error(`عضویت ممکن نیست (${channel.identifier}): ${reason}`);
  }
  //#endregion ------------------------------------------------------------------------------------------------

  //#region ------------------- خطاهای جوین شدن رو در دیتابیس اعلام و به کاربر اعلام میکنه --------
  private async handleJoinError(channel: C, error: unknown): Promise<void> {
    await this.refreshOwners(channel);

    const decision: JoinErrorDecision =
      error instanceof PermanentJoinError
        ? { kind: 'permanent', reason: error.message }
        : this.classifyJoinError(error);

    if (decision.kind === 'pause') {
      this.pausedUntil = Date.now() + decision.seconds * 1000;
      channel.nextAttemptAt = new Date(this.pausedUntil);
      channel.lastError = decision.reason;
      await this.channelRepo.save(channel);
      this.logger.warn(
        `⛔ ${decision.reason} -- همه‌ی عملیات عضویت ${Math.ceil(decision.seconds / 60)} دقیقه متوقف شد.`,
      );
      return;
    }

    if (decision.kind === 'permanent') {
      await this.markFailed(channel, decision.reason);
      return;
    }

    channel.retryCount += 1;
    channel.lastError = (error as Error)?.message ?? String(error);

    const { maxJoinAttempts } = this.policy;
    if (maxJoinAttempts && channel.retryCount >= maxJoinAttempts) {
      await this.markFailed(channel, `بعد از ${channel.retryCount} تلاش ناموفق: ${channel.lastError}`);
      return;
    }

    const backoffMinutes = exponentialBackoffMinutes(
      channel.retryCount,
      this.policy.backoffBaseMinutes,
      this.policy.backoffMaxMinutes,
    );
    channel.nextAttemptAt = new Date(Date.now() + backoffMinutes * 60_000);
    await this.channelRepo.save(channel);

    this.logger.error(
      `عضویت ناموفق بود: ${channel.identifier} -- ${backoffMinutes} دقیقه‌ی دیگه دوباره تلاش می‌شه (تلاش #${channel.retryCount})`,
      error as Error,
    );
  }
  //#endregion -----------------------------------------------------------------------------------
}
