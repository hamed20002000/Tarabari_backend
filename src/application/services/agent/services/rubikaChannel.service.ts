import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
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

const INITIALIZE_TIMEOUT_MS = 60_000;

/**
 * گوش دادن به گروه/کانال‌های روبیکا با یک اکانت کاربری (rubjs -- API غیررسمی
 * وب روبیکا). منطق عضویت و پردازش پیام در AccountChannelMonitor مشترکه؛ اینجا
 * فقط اتصال و فراخوانی‌های خود روبیکا هست. اتصال مجدد websocket رو خود
 * rubjs انجام می‌ده.
 */
@Injectable()
export class RubikaChannelService extends AccountChannelMonitor<RubikaMonitoredChannel, RubikaChannelMessage> {
  private client: RubikaClient | null = null;

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
      // rubjs برای درخواست ناموفق فقط undefined برمی‌گردونه (بدون کد خطا) --
      // خطای تکراری ناموفق اعلام می‌شه.
      maxJoinAttempts: Number(process.env.RUBIKA_MAX_JOIN_ATTEMPTS) || 8,
    });
  }

  protected get isConnected(): boolean {
    return !!this.client;
  }

  protected async disconnect(): Promise<void> {
    const network = this.client?.network;
    this.client = null;
    if (!network) return;
    // reconnecting=true جلوی اتصال مجدد خودکار rubjs بعد از بستن رو می‌گیره.
    network.reconnecting = true;
    clearInterval(network.heartbeatInterval);
    clearTimeout(network.inactivityTimeout);
    network.ws?.close();
  }

  protected async connect(session: string): Promise<void> {
    // نشست همون خروجی رمزشده‌ی rubjs ({ iv, enData }) هست که اسکریپت لاگین ذخیره کرده.
    // سازنده‌ی Client خودش اتصال رو شروع می‌کنه.
    const client = new RubikaClient(JSON.parse(session));
    client.on('message', async (ctx) => this.onMessage(ctx));

    // اگه نشست نامعتبر باشه، rubjs منتظر ورود شماره از ترمینال می‌مونه و هیچ‌وقت آماده نمی‌شه.
    const deadline = Date.now() + INITIALIZE_TIMEOUT_MS;
    while (!client.initialize && Date.now() < deadline) await sleep(1_000);
    if (!client.initialize) {
      this.logger.error('نشست روبیکا نامعتبره یا اتصال برقرار نشد -- دوباره `npm run rubika:login` رو اجرا کنید.');
      return;
    }

    void client.run().catch((error) => this.logger.error('دریافت آپدیت‌های روبیکا متوقف شد', error as Error));
    this.client = client;
    this.logger.log(`اکانت روبیکا متصل شد: ${client.userGuid}`);
  }

  private onMessage(ctx: RubikaMessage): void {
    // g0 = گروه، c0 = کانال -- پیوی (u0) و ربات‌ها (b0) نادیده گرفته می‌شن.
    const chatId = ctx.object_guid;
    if (!chatId?.startsWith('g0') && !chatId?.startsWith('c0')) return;
    if (ctx.action && ctx.action !== 'New') return;

    const text = (ctx.message?.text ?? '').trim();
    const file = ctx.message?.file_inline;
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
            const audio: Buffer = await this.client!.download(file);
            if (!audio?.length) throw new Error('فایل صوتی روبیکا دانلود نشد.');
            return audio;
          },
        }
        : undefined,
    });
  }

  protected classifyJoinError(error: unknown): JoinErrorDecision {
    const message = (error as Error)?.message ?? '';
    if (/TOO_REQUESTS|TOO_MANY|FLOOD/i.test(message)) {
      return { kind: 'pause', seconds: 60 * 60 + randomBetween(60, 300), reason: `روبیکا محدودیت درخواست داد: ${message}` };
    }
    return { kind: 'retry' };
  }

  // ------------------------------------------------------------------
  // فراخوانی‌های روبیکا
  // ------------------------------------------------------------------

  protected async join(identifier: string): Promise<JoinResult> {
    const client = this.client!;
    const parsed = RubikaChannelService.parseIdentifier(identifier);

    if (parsed.kind === 'username') {
      const found = await this.request(client.getObjectByUsername(parsed.username));
      if (!found.exist) throw new PermanentJoinError('گروه/کانالی با این آیدی در روبیکا پیدا نشد.');
      if (!found.channel?.channel_guid) throw new PermanentJoinError('این آیدی مربوط به کانال نیست.');

      // مثل کاربر واقعی: اول جستجو، بعد چند ثانیه مکث، بعد عضویت.
      await sleep(randomBetween(3_000, 8_000));
      await this.request(client.joinChannelAction(found.channel.channel_guid, 'Join'));
      return this.channelResult(found.channel);
    }

    await sleep(randomBetween(3_000, 8_000));

    // فقط hash پاس داده می‌شه -- پارس لینک خود rubjs برای joinChannelByLink خرابه.
    if (parsed.kind === 'group-invite') {
      const result = await this.request(client.joinGroup(parsed.hash));
      if (!result.group?.group_guid) throw new Error('عضویت انجام شد ولی شناسه‌ی گروه به دست نیومد.');
      return {
        chatId: result.group.group_guid,
        title: result.group.group_title ?? null,
        type: MonitoredChatType.GROUP,
        pending: false,
      };
    }

    const result = await this.request(client.joinChannelByLink(parsed.hash));
    if (!result.channel?.channel_guid) throw new Error('عضویت انجام شد ولی شناسه‌ی کانال به دست نیومد.');
    return this.channelResult(result.channel);
  }

  /** rubjs برای درخواست ناموفق به‌جای خطا undefined برمی‌گردونه. */
  private async request<T>(promise: Promise<T | undefined>): Promise<T> {
    const result = await promise;
    if (!result) throw new Error('درخواست روبیکا ناموفق بود (لینک نامعتبر/منقضی یا دسترسی نداشتن).');
    return result;
  }

  private channelResult(channel: { channel_guid: string; channel_title?: string }): JoinResult {
    return {
      chatId: channel.channel_guid,
      title: channel.channel_title ?? null,
      type: MonitoredChatType.CHANNEL,
      pending: false,
    };
  }

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
