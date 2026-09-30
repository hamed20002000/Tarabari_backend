import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Cron } from '@nestjs/schedule';
import { TelegramClient, Api, utils } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { NewMessage, NewMessageEvent } from 'telegram/events';
import { FloodWaitError, RPCError } from 'telegram/errors';
import { LogLevel } from 'telegram/extensions/Logger';
import { TelegramMonitoredChannel } from '../entities/TelegramMonitoredChannel';
import { TelegramChannelMessage } from '../entities/TelegramChannelMessage';
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
import { buildTelegramClientParams, getTelegramApiCredentials } from './telegramClient.config';

export type ParsedIdentifier = { kind: 'invite'; hash: string } | { kind: 'username'; username: string };

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

/**
 * گوش دادن به گروه/کانال‌های تلگرام با یک اکانت کاربری (GramJS / MTProto) --
 * منطق عضویت و پردازش پیام در AccountChannelMonitor مشترکه؛ اینجا فقط
 * اتصال و فراخوانی‌های خود تلگرام هست.
 */
@Injectable()
export class TelegramChannelService extends AccountChannelMonitor<TelegramMonitoredChannel, TelegramChannelMessage> {
  private client: TelegramClient | null = null;

  constructor(
    @InjectRepository(TelegramMonitoredChannel)
    monitoredChannelRepo: Repository<TelegramMonitoredChannel>,
    @InjectRepository(TelegramChannelMessage)
    channelMessageRepo: Repository<TelegramChannelMessage>,
    @InjectRepository(MessengerSession)
    sessionRepo: Repository<MessengerSession>,
    cargoPipeline: CargoPipelineService,
    membership: ChannelMembershipService,
    speechToTextService: SpeechToTextService,
  ) {
    super('telegram', monitoredChannelRepo, channelMessageRepo, sessionRepo, cargoPipeline, membership, speechToTextService);
  }

  protected get isConnected(): boolean {
    return !!this.client;
  }

  protected async disconnect(): Promise<void> {
    await this.client?.disconnect();
  }

  protected async connect(session: string): Promise<void> {
    const credentials = getTelegramApiCredentials();
    if (!credentials) {
      this.logger.warn('TELEGRAM_API_ID/TELEGRAM_API_HASH تعریف نشده -- مانیتورینگ تلگرام غیرفعاله.');
      return;
    }

    const client = new TelegramClient(
      new StringSession(session),
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
    if (savedSession && savedSession !== session) {
      await this.updateSession(savedSession);
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
  }

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

    const audioAttr = msg.voice?.attributes.find(
      (attr): attr is Api.DocumentAttributeAudio => attr instanceof Api.DocumentAttributeAudio,
    );

    this.enqueueMessage({
      chatId,
      messageId: msg.id,
      text,
      voice: isVoice
        ? {
          durationSeconds: audioAttr?.duration ?? 0,
          download: async () => {
            const audio = await this.client!.downloadMedia(msg, {});
            if (!Buffer.isBuffer(audio)) throw new Error('فایل صوتی دانلود نشد.');
            return audio;
          },
        }
        : undefined,
    });
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

  protected classifyJoinError(error: unknown): JoinErrorDecision {
    if (error instanceof FloodWaitError) {
      return {
        kind: 'pause',
        seconds: error.seconds + randomBetween(30, 120),
        reason: `FloodWait: تلگرام ${error.seconds} ثانیه محدودیت داد.`,
      };
    }

    const code = error instanceof RPCError ? error.errorMessage : null;

    if (code === 'CHANNELS_TOO_MUCH') {
      return { kind: 'pause', seconds: 24 * 60 * 60, reason: 'اکانت به سقف تعداد گروه/کانال تلگرام (۵۰۰) رسیده.' };
    }

    if (code && PERMANENT_JOIN_ERRORS[code]) {
      return { kind: 'permanent', reason: PERMANENT_JOIN_ERRORS[code] };
    }
    if (/No user has .* as username/i.test((error as Error)?.message ?? '')) {
      return { kind: 'permanent', reason: PERMANENT_JOIN_ERRORS.USERNAME_NOT_OCCUPIED };
    }

    return { kind: 'retry' };
  }

  // ------------------------------------------------------------------
  // فراخوانی‌های تلگرام
  // ------------------------------------------------------------------

  protected async join(identifier: string): Promise<JoinResult> {
    const client = this.client!;
    const parsed = TelegramChannelService.parseIdentifier(identifier);

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

  protected async checkMembership(identifier: string): Promise<JoinResult | null> {
    const client = this.client!;
    const parsed = TelegramChannelService.parseIdentifier(identifier);

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
  static parseIdentifier(identifier: string): ParsedIdentifier {
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

  /**
   * شکل یکتای لینک برای ذخیره در identifier -- تا لینک‌های مختلفِ یک
   * گروه/کانال (t.me/x، @x، https://t.me/x) یک رکورد بشن. لینک نامعتبر = null.
   */
  static normalizeIdentifier(identifier: string): string | null {
    try {
      const parsed = TelegramChannelService.parseIdentifier(identifier);
      return parsed.kind === 'invite'
        ? `https://t.me/+${parsed.hash}`
        : `@${parsed.username.toLowerCase()}`;
    } catch {
      return null;
    }
  }
}
