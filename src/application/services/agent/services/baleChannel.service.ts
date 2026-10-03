import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import axios from 'axios';
import {
  BaleRpcError,
  Chat as BaleChat,
  ChatType as BaleChatType,
  Client as BaleClient,
  Message as BaleMessage,
} from '@hoseinbnoob/balejs';
import { BaleMonitoredChannel } from '../entities/BaleMonitoredChannel';
import { BaleChannelMessage } from '../entities/BaleChannelMessage';
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

type ParsedIdentifier = { kind: 'invite'; token: string } | { kind: 'username'; username: string };

const RECONNECT_DELAY_MS = 60_000;

/**
 * گوش دادن به گروه/کانال‌های بله با یک اکانت کاربری (balejs -- API غیررسمی
 * وب بله). منطق عضویت و پردازش پیام در AccountChannelMonitor مشترکه؛ اینجا
 * فقط اتصال و فراخوانی‌های خود بله هست. بله درخواست عضویت (pending) نداره.
 */
@Injectable()
export class BaleChannelService extends AccountChannelMonitor<BaleMonitoredChannel, BaleChannelMessage> {
  private client: BaleClient | null = null;
  private stopped = false;
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor(
    @InjectRepository(BaleMonitoredChannel)
    monitoredChannelRepo: Repository<BaleMonitoredChannel>,
    @InjectRepository(BaleChannelMessage)
    channelMessageRepo: Repository<BaleChannelMessage>,
    @InjectRepository(MessengerSession)
    sessionRepo: Repository<MessengerSession>,
    cargoPipeline: CargoPipelineService,
    membership: ChannelMembershipService,
    speechToTextService: SpeechToTextService,
  ) {
    super('bale', monitoredChannelRepo, channelMessageRepo, sessionRepo, cargoPipeline, membership, speechToTextService, {
      // کدهای خطای API غیررسمی بله مستند نیست -- خطای ناشناخته‌ی تکراری ناموفق اعلام می‌شه.
      maxJoinAttempts: Number(process.env.BALE_MAX_JOIN_ATTEMPTS) || 8,
    });
  }

  protected get isConnected(): boolean {
    return !!this.client;
  }

  protected async disconnect(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    await this.client?.stop();
  }

  protected async connect(session: string): Promise<void> {
    const client = new BaleClient(session);

    client.on_message((message) => this.onMessage(message));
    client.on_error((error) => this.logger.error('خطای کلاینت بله', error as Error));
    client.on_connect(() => {
      this.client = client;
      this.logger.log(`اکانت بله متصل شد: ${client.user?.username ? '@' + client.user.username : client.user?.id}`);
    });

    // run تا قطع اتصال (یا خطای اتصال) برنمی‌گرده -- بعدش دوباره وصل می‌شیم.
    // catch لازمه -- finally خطا رو دوباره پرتاب می‌کنه و unhandled rejection پروسه رو می‌بست.
    void client
      .run()
      .catch((error) => this.logger.error('اتصال بله با خطا تموم شد', error as Error))
      .finally(() => {
        this.client = null;
        if (this.stopped) return;
        this.logger.warn(`اتصال بله قطع شد -- ${RECONNECT_DELAY_MS / 1000} ثانیه‌ی دیگه دوباره وصل می‌شه.`);
        this.reconnectTimer = setTimeout(() => void this.connect(session), RECONNECT_DELAY_MS);
      });
  }

  private onMessage(message: BaleMessage): void {
    const { chat } = message;
    if (chat.type === BaleChatType.PRIVATE || chat.type === BaleChatType.BOT) return;

    // int64ها رو balejs به Number تبدیل می‌کنه؛ برای دانلود فایل همون‌ها رو برمی‌گردونیم.
    const document = (message.raw as any)?.message?.document_message;
    const voice = document?.ext?.document_ex_voice;

    const text = (message.text ?? message.caption ?? '').trim();
    const isVoice = !text && !!voice;
    if (!text && !isVoice) return;

    this.enqueueMessage({
      chatId: String(chat.peerId),
      messageId: String(message.rid),
      text,
      voice: isVoice
        ? {
          durationSeconds: Number(voice.duration ?? 0),
          download: async () => {
            const response = await this.client!.get_file(document.file_id, document.access_hash);
            const url = response?.file_url?.url;
            if (!url) throw new Error('آدرس فایل صوتی بله به دست نیومد.');
            const { data } = await axios.get<ArrayBuffer>(url, { responseType: 'arraybuffer', timeout: 60_000 });
            return Buffer.from(data);
          },
        }
        : undefined,
    });
  }

  protected classifyJoinError(error: unknown): JoinErrorDecision {
    const message = (error as Error)?.message ?? '';

    // gRPC 8 = RESOURCE_EXHAUSTED
    if ((error instanceof BaleRpcError && (error.code === 8 || error.code === 429)) || /FLOOD|TOO_MANY|RATE_LIMIT/i.test(message)) {
      return { kind: 'pause', seconds: 60 * 60 + randomBetween(60, 300), reason: `بله محدودیت درخواست داد: ${message}` };
    }

    // gRPC 5 = NOT_FOUND، 7 = PERMISSION_DENIED
    if ((error instanceof BaleRpcError && (error.code === 5 || error.code === 7)) || /NOT_FOUND|EXPIRED|INVALID|BANNED|FORBIDDEN/i.test(message)) {
      return { kind: 'permanent', reason: `لینک نامعتبر/منقضیه یا اکانت اجازه‌ی عضویت نداره (${message}).` };
    }

    return { kind: 'retry' };
  }

  // ------------------------------------------------------------------
  // فراخوانی‌های بله
  // ------------------------------------------------------------------

  protected async join(identifier: string): Promise<JoinResult> {
    const client = this.client!;
    const parsed = BaleChannelService.parseIdentifier(identifier);

    if (parsed.kind === 'invite') {
      await sleep(randomBetween(3_000, 8_000));
      return this.fromChat(await client.join_chat(parsed.token));
    }

    const found = await client.get_chat(parsed.username);
    if (!found) throw new PermanentJoinError('گروه/کانالی با این آیدی در بله پیدا نشد.');
    if (!(found instanceof BaleChat) || found.type === BaleChatType.PRIVATE || found.type === BaleChatType.BOT) {
      throw new PermanentJoinError('این آیدی مربوط به گروه/کانال نیست.');
    }

    // مثل کاربر واقعی: اول جستجو، بعد چند ثانیه مکث، بعد عضویت.
    await sleep(randomBetween(3_000, 8_000));

    try {
      return this.fromChat(await client.join_public_chat(`${found.peerId}|${found.peerType}`));
    } catch (error) {
      if (/ALREADY/i.test((error as Error)?.message ?? '')) return this.fromChat(found);
      throw error;
    }
  }

  private fromChat(chat: BaleChat): JoinResult {
    return {
      chatId: String(chat.peerId),
      title: chat.title ?? null,
      type: chat.type === BaleChatType.CHANNEL ? MonitoredChatType.CHANNEL : MonitoredChatType.GROUP,
      pending: false,
    };
  }

  /**
   * لینک خصوصی: ble.ir/join/TOKEN
   * لینک عمومی: ble.ir/username
   * (@username به‌تنهایی آیدی تلگرام حساب می‌شه، برای همین دامنه‌ی ble.ir الزامیه.)
   */
  static parseIdentifier(identifier: string): ParsedIdentifier {
    const value = identifier.trim();

    const invite = value.match(/^(?:https?:\/\/)?(?:www\.)?ble\.ir\/join\/([\w-]+)/i);
    if (invite) return { kind: 'invite', token: invite[1] };

    const link = value.match(/^(?:https?:\/\/)?(?:www\.)?ble\.ir\/@?([A-Za-z][A-Za-z0-9_]{3,})\/?$/i);
    if (link) return { kind: 'username', username: link[1] };

    throw new PermanentJoinError('فرمت لینک بله نامعتبره.');
  }

  /** شکل یکتای لینک برای ذخیره در identifier؛ لینکی که مال بله نیست = null. */
  static normalizeIdentifier(identifier: string): string | null {
    try {
      const parsed = BaleChannelService.parseIdentifier(identifier);
      return parsed.kind === 'invite'
        ? `https://ble.ir/join/${parsed.token}`
        : `https://ble.ir/${parsed.username.toLowerCase()}`;
    } catch {
      return null;
    }
  }
}
