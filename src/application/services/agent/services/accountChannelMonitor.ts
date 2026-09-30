import { Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import {
  DeepPartial,
  EntityTarget,
  FindOptionsOrder,
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

  // ------------------------------------------------------------------
  // بخش‌های مخصوص هر پلتفرم
  // ------------------------------------------------------------------

  /** با نشست ذخیره‌شده وصل می‌شه و شنونده‌ی پیام‌ها رو (با enqueueMessage) ثبت می‌کنه. */
  protected abstract connect(session: string): Promise<void>;

  protected abstract disconnect(): Promise<void>;

  /** تا وقتی false باشه، cron عضویت کاری نمی‌کنه. */
  protected abstract get isConnected(): boolean;

  /** عضویت با لینک (یا ارسال درخواست عضویت اگه تایید ادمین لازم باشه). */
  protected abstract join(identifier: string): Promise<JoinResult>;

  /** خطای عضویت رو به تصمیم مشترک ترجمه می‌کنه (PermanentJoinError از قبل پوشش داده شده). */
  protected abstract classifyJoinError(error: unknown): JoinErrorDecision;

  /**
   * اگه اکانت عضو شده باشه نتیجه‌ی عضویت رو برمی‌گردونه، وگرنه null. فقط برای
   * پلتفرم‌هایی لازمه که درخواست عضویت (pending) دارن.
   */
  protected checkMembership?(identifier: string): Promise<JoinResult | null>;

  // ------------------------------------------------------------------
  // اتصال
  // ------------------------------------------------------------------

  onModuleInit() {
    // اتصال نباید بالا اومدن کل برنامه رو معطل کنه.
    void this.start();
  }

  async onModuleDestroy() {
    await this.disconnect().catch(() => undefined);
  }

  private async start(): Promise<void> {
    // بدون اتصال، نه عضویتی انجام می‌شه و نه پیامی دریافت می‌شه.
    if (!isChannelMonitoringEnabled(this.platform)) {
      this.logger.warn(`${this.platform} در CHANNEL_MONITORING_ENABLED نیست -- عضویت و گوش دادن به گروه/کانال‌هاش غیرفعاله.`);
      return;
    }

    const stored = await this.sessionRepo.findOne({ where: { sessionId: this.platform } });
    if (!stored) {
      this.logger.warn(`نشست ${this.platform} پیدا نشد -- یک بار \`npm run ${this.platform}:login\` رو اجرا کنید.`);
      return;
    }

    try {
      await this.connect(stored.session);
    } catch (error) {
      this.logger.error(`اتصال به ${this.platform} ناموفق بود`, error as Error);
    }
  }

  /** اگه نشست بعد از اتصال عوض شده باشه (مثلاً تمدید توکن)، نسخه‌ی جدید ذخیره می‌شه. */
  protected async updateSession(session: string): Promise<void> {
    await this.sessionRepo.update({ sessionId: this.platform }, { session });
  }

  // ------------------------------------------------------------------
  // دریافت پیام‌ها
  // ------------------------------------------------------------------

  protected enqueueMessage(message: IncomingChatMessage): void {
    // پیام‌ها یکی‌یکی پردازش می‌شن -- جلوگیری از درخواست‌های هم‌زمان به Ollama.
    void this.messageQueue.run(() => this.handleChatMessage(message)).catch((error) =>
      this.logger.error(`خطا در پردازش پیام گروه/کانال ${this.platform}: ${message.chatId}`, error as Error),
    );
  }

  /**
   * پردازش یک پیام جدید از گروه یا کانال: تشخیص سفارش بار، و فقط برای سفارش
   * بار -- ذخیره در دیتابیس و انتشار event (cargo.message.detected) از طریق
   * Outbox Pattern برای توزیع‌کننده.
   */
  private async handleChatMessage({ chatId, messageId, text, voice }: IncomingChatMessage): Promise<void> {
    const key = `${chatId}:${messageId}`;
    const label = `${this.platform} ${key}`;
    if (this.recentMessageKeys.has(key)) return;

    // فقط از گروه/کانال‌هایی که به‌عنوان منبع ثبت و فعال شدن پیام می‌خونیم.
    const channel = await this.channelRepo.findOne({
      where: {
        chatId,
        isActive: true,
        role: In([MonitoredChannelRole.SOURCE, MonitoredChannelRole.BOTH]),
      } as FindOptionsWhere<C>,
    });
    if (!channel) return;

    // رسیدن پیام یعنی عضو هستیم -- مثلاً درخواست عضویت تازه تایید شده.
    if (!channel.isMember) {
      channel.isMember = true;
      channel.joinRequestPending = false;
      channel.joinedAt = channel.joinedAt ?? new Date();
      channel.lastError = null;
      channel.nextAttemptAt = null;
      await this.membership.transition(this.platform, channel, ChannelMembershipStatus.JOINED);
    }

    const existing = await this.messageRepo.findOne({ where: { chatId, messageId } as FindOptionsWhere<M> });
    if (existing) return;

    this.recentMessageKeys.add(key);

    // پیام صوتی: اول به متن تبدیل می‌شه و بعد مثل پیام متنی بررسی می‌شه.
    if (voice) {
      text = await this.speechToText.transcribeVoice(voice.durationSeconds, voice.download, label);
      if (!text) return;
    }

    await this.cargoPipeline.process({
      label,
      text,
      isVoice: !!voice,
      entity: this.messageRepo.target as EntityTarget<M>,
      record: { chatId, messageId } as DeepPartial<M>,
      source: { platform: this.platform, chatId },
      ownerUserIds: channel.ownerUserIds,
    });
  }

  // ------------------------------------------------------------------
  // عضویت در گروه/کانال‌های ثبت‌شده در دیتابیس
  // ------------------------------------------------------------------

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

  /** در هر اجرا حداکثر یک عضویت -- با فاصله‌ی تصادفی و سقف روزانه. */
  private async joinNextChannel(): Promise<void> {
    if (Date.now() < this.nextJoinAllowedAt) return;

    const attemptsLast24h = await this.channelRepo.count({
      where: { lastJoinAttemptAt: MoreThanOrEqual(new Date(Date.now() - 24 * 60 * 60 * 1000)) } as FindOptionsWhere<C>,
    });
    if (attemptsLast24h >= this.policy.dailyJoinLimit) return;

    const now = new Date();
    const pendingFilter = {
      isActive: true,
      isMember: false,
      joinRequestPending: false,
      identifier: Not(IsNull()),
    };
    const channel = await this.channelRepo.findOne({
      where: [
        { ...pendingFilter, nextAttemptAt: IsNull() },
        { ...pendingFilter, nextAttemptAt: LessThanOrEqual(now) },
      ] as FindOptionsWhere<C>[],
      order: { createdAt: 'ASC' } as FindOptionsOrder<C>,
    });
    if (!channel) return;

    channel.lastJoinAttemptAt = now;
    this.nextJoinAllowedAt =
      Date.now() + (this.policy.joinMinIntervalMinutes + Math.random() * this.policy.joinJitterMinutes) * 60_000;

    try {
      const result = await this.join(channel.identifier!);
      await this.applyJoinResult(channel, result);
    } catch (error) {
      await this.handleJoinError(channel, error);
    }
  }

  /** درخواست‌های عضویتِ منتظر تایید رو بررسی می‌کنه (بدون فرستادن درخواست جدید). */
  private async recheckPendingRequests(): Promise<void> {
    const pending = await this.channelRepo.find({
      where: {
        isActive: true,
        joinRequestPending: true,
        nextAttemptAt: LessThanOrEqual(new Date()),
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

  private async applyJoinResult(channel: C, result: JoinResult): Promise<void> {
    if (result.chatId && result.chatId !== channel.chatId) {
      const duplicate = await this.channelRepo.findOne({ where: { chatId: result.chatId } as FindOptionsWhere<C> });
      if (duplicate && duplicate.id !== channel.id) {
        // همون گروه/کانال با لینک دیگه‌ای ثبت شده -- ثبت‌کننده‌های این رکورد
        // به رکورد اصلی منتقل می‌شن تا اعلان‌ها براشون قطع نشه.
        const missingOwners = channel.ownerUserIds.filter((id) => !duplicate.ownerUserIds.includes(id));
        if (missingOwners.length > 0) {
          duplicate.ownerUserIds = [...duplicate.ownerUserIds, ...missingOwners];
          await this.channelRepo.save(duplicate);
          // وضعیت رکورد اصلی (مثلاً «عضو شد») به کاربرهای منتقل‌شده اعلام می‌شه.
          await this.membership.announce(this.platform, duplicate, missingOwners);
        }
        // ثبت‌کننده‌ها منتقل شدن -- این رکورد دیگه در لیست هیچ کاربری نمیاد.
        channel.ownerUserIds = [];
        channel.isActive = false;
        channel.joinRequestPending = false;
        channel.nextAttemptAt = null;
        channel.lastError = `این گروه/کانال قبلاً با رکورد دیگه‌ای ثبت شده (${duplicate.identifier ?? duplicate.id}).`;
        await this.channelRepo.save(channel);
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

  /** عضویت ممکن نیست -- رکورد غیرفعال می‌شه و به ثبت‌کننده‌ها اعلام می‌شه. */
  private async markFailed(channel: C, reason: string): Promise<void> {
    channel.isActive = false;
    channel.joinRequestPending = false;
    channel.nextAttemptAt = null;
    channel.lastError = reason;
    await this.membership.transition(this.platform, channel, ChannelMembershipStatus.FAILED, reason);
    this.logger.error(`عضویت ممکن نیست (${channel.identifier}): ${reason}`);
  }

  private async handleJoinError(channel: C, error: unknown): Promise<void> {
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
}
