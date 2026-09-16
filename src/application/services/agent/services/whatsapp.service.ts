import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, IsNull, LessThanOrEqual, In, Not } from 'typeorm';
import { Cron } from '@nestjs/schedule';
import makeWASocket, {
  DisconnectReason,
  WASocket,
  proto,
  downloadMediaMessage,
  WAMessage,
  fetchLatestBaileysVersion,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import * as qrcode from 'qrcode-terminal';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { WhatsappAuthCredential } from '../entities/WhatsappAuthCredential';
import { WhatsappAuthKey } from '../entities/WhatsappAuthKey';
import { WhatsappUserMapping } from '../entities/WhatsappUserMapping';
import { WhatsappChannelMessage } from '../entities/WhatsappChannelMessage';
import { MonitoredChannel } from '../entities/MonitoredChannel';
import { MonitoredChatType, MonitoredChannelRole } from '../types';
import { useDbAuthState } from '../hooks/useDbAuthState';
import { AuthService } from 'src/auth/auth.service';
import { TransportOrderService, CargoOrderExtraction } from '../services/aiTools.service';

const execAsync = promisify(exec);
const DEFAULT_SESSION_ID = 'main';
const CHANNEL_REPLACEMENT_NUMBER = '09394113259'; // بهتره از config/env بیاد

// NEW: شماره‌ی شخصی که علاوه بر گروه/کانال‌های مقصد، پیام‌های پردازش‌شده
// (سفارش‌های بار تشخیص‌داده‌شده) مستقیماً بهش هم فرستاده می‌شن. از .env
// خونده می‌شه -- اگه خالی باشه، این قابلیت به‌سادگی غیرفعال می‌مونه.
const PERSONAL_NOTIFY_NUMBER = process.env.WHATSAPP_PERSONAL_NOTIFY_NUMBER || '';

@Injectable()
export class WhatsappService implements OnModuleInit {
  private readonly logger = new Logger(WhatsappService.name);
  private sock: WASocket | null = null;

  private activeProgressMessages = new Map<string, proto.IMessageKey>();

  private pendingSelections = new Map<
    string,
    { userId: string; options: { value: any; label: string }[]; page: number; message: string }
  >();

  private static readonly SELECTION_PAGE_SIZE = 10;

  // NEW: صف پیام‌های گروه/کانال که هنوز پردازش نشدن. چون رویداد
  // 'messages.upsert' می‌تونه چند بار پشت‌سرهم (حتی هم‌زمان) فایر بشه،
  // بدون این صف ممکنه چند پیام هم‌زمان به Ollama فرستاده بشن و باعث
  // timeout بشن (چون Ollama درخواست‌ها رو صف می‌کنه، نه هم‌زمان پردازش).
  // با این صف، تضمین می‌شه که پیام بعدی فقط بعد از تموم شدن کامل پیام
  // قبلی (پردازش مدل + ذخیره + فوروارد) شروع بشه.
  private channelMessageQueue: WAMessage[] = [];
  private isProcessingChannelQueue = false;

  // فاصله بین درخواست‌های فالو/جوین پشت‌سرهم -- جلوگیری از الگوی burst
  // مشکوک وقتی چند گروه/کانال هم‌زمان در دیتابیس اضافه شدن. این مقدار
  // خصوصاً برای شماره‌های تازه‌وصل‌شده (که هنوز "اعتماد" واتساپ رو جلب
  // نکردن) بالا نگه داشته شده -- عضویت‌های سریع و پشت‌سرهم می‌تونه باعث
  // بشه واتساپ session رو به‌عنوان رفتار ربات‌مانند باطل کنه (loggedOut).
  private static readonly FOLLOW_DELAY_MS = 15000; // ۱۵ ثانیه

  // NEW: پارامترهای exponential backoff برای تلاش مجدد بعد از شکست.
  // فاصله = BASE_MINUTES * (2 ^ (retryCount - 1))، با سقف MAX_MINUTES.
  // یعنی: تلاش ۱ fail بشه -> ۵ دقیقه صبر، تلاش ۲ -> ۱۰ دقیقه، تلاش ۳ ->
  // ۲۰ دقیقه، ... تا سقف ۶۰ دقیقه، نه اینکه هر ۲ دقیقه (فاصله‌ی Cron)
  // بی‌وقفه دوباره امتحان کنه.
  private static readonly BACKOFF_BASE_MINUTES = 5;
  private static readonly BACKOFF_MAX_MINUTES = 60;

  // NEW: بعد از اتصال، اگه PERSONAL_NOTIFY_NUMBER تنظیم شده باشه، JID
  // تاییدشده‌اش اینجا کش می‌شه -- تا لازم نباشه هر بار دوباره onWhatsApp
  // صدا زده بشه.
  private personalNotifyJid: string | null = null;

  constructor(
    @InjectRepository(WhatsappAuthCredential)
    private readonly credentialRepo: Repository<WhatsappAuthCredential>,
    @InjectRepository(WhatsappAuthKey)
    private readonly keyRepo: Repository<WhatsappAuthKey>,
    @InjectRepository(WhatsappUserMapping)
    private readonly userMappingRepo: Repository<WhatsappUserMapping>,
    @InjectRepository(WhatsappChannelMessage)
    private readonly channelMessageRepo: Repository<WhatsappChannelMessage>,
    @InjectRepository(MonitoredChannel)
    private readonly monitoredChannelRepo: Repository<MonitoredChannel>,
    private readonly authService: AuthService,
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

    // نسخه‌ی پیش‌فرض هاردکد داخل Baileys ممکنه قدیمی بشه و واتساپ دیگه
    // قبولش نکنه -- که باعث می‌شه handshake حتی قبل از رسیدن به مرحله‌ی QR
    // با خطای 401 رد بشه. با گرفتن نسخه‌ی واقعی از سرور، این ریسک از بین
    // می‌ره.
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
        // بلافاصله بعد از اتصال، یه بار sync بزن (نه فقط منتظر Cron بعدی بمون)
        void this.sock.updateProfileName('باربری تارابری').catch((err) =>
          this.logger.error('پروفایل نیم تنظیم نشد', err),
        );

        // NEW: اگه شماره‌ی شخصی در .env تنظیم شده، همین‌جا (یک‌بار بعد از
        // هر اتصال موفق) تاییدش می‌کنیم و JID واقعی‌ش رو کش می‌کنیم.
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

    // این رویداد هر بار تغییری در اعضای یه گروه اتفاق بیفته فایر می‌شه --
    // شامل add (اضافه شدن عضو جدید)، remove (حذف/اخراج عضو)، promote/demote
    // (ارتقا/تنزل به ادمین). اینجا فقط حالت remove که خود بات رو شامل بشه
    // رو بررسی می‌کنیم تا بفهمیم بات از گروه اخراج شده یا نه.
    this.sock.ev.on('group-participants.update', async (update) => {
      const { id: groupJid, participants, action } = update;

      if (action !== 'remove') return;

      // JID خود بات -- برای مقایسه با لیست participants حذف‌شده
      const myJid = this.sock?.user?.id;
      if (!myJid) return;

      const normalizedMyJid = myJid.split(':')[0]; // حذف device suffix احتمالی
      // در نسخه‌های جدید Baileys، هر عضو یه آبجکت GroupParticipant (با
      // فیلد id) هست، نه یه رشته‌ی خام JID -- برای همین اول .id رو
      // می‌خونیم و بعد split می‌کنیم.
      const wasRemoved = participants.some(
        (p) => p.id.split(':')[0] === normalizedMyJid,
      );

      if (!wasRemoved) return; // یعنی یکی دیگه حذف شده، نه خود بات

      this.logger.warn(`🚫 Bot gruptan çıkarıldı: ${groupJid}`);

      // در دیتابیس این وضعیت رو ثبت می‌کنیم تا مدیر بفهمه دیگه پیام‌های این
      // گروه دریافت نمی‌شه. isActive رو هم false می‌کنیم تا polling دیگه
      // خودکار سراغ این گروه نره -- اگه مدیر بخواد دوباره اضافه بشه، باید
      // دستی از پنل isActive رو true کنه (یا رکورد جدید بسازه).
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

        // پیام‌های کانال (Newsletter) و گروه (Group) هر دو با یه منطق
        // مشترک (handleChannelMessage) پردازش می‌شن -- فقط JID متفاوته.
        if (remoteJid?.endsWith('@newsletter') || remoteJid?.endsWith('@g.us')) {
          // NEW: به‌جای پردازش مستقیم و هم‌زمان، پیام رو وارد صف می‌کنیم.
          // خود enqueueChannelMessage غیر-async صدا زده می‌شه (بدون await)
          // چون فقط پیام رو به صف اضافه می‌کنه و پردازش واقعی توسط
          // processChannelQueue به‌ترتیب و یکی‌یکی انجام می‌شه.
          this.enqueueChannelMessage(msg);
          continue;
        }

        if (msg.key.fromMe) continue;

        const rawJid = msg.key.remoteJid;
        const jid = msg.key.remoteJid?.endsWith('@lid')
          ? (msg.key as any).remoteJidAlt || rawJid
          : rawJid;

        if (!jid) continue;

        if (rawJid?.endsWith('@lid') && jid === rawJid) {
          this.logger.warn(
            `@lid jid için remoteJidAlt bulunamadı, ham @lid ile devam ediliyor: ${rawJid}`,
          );
        }

        const audioMessage = msg.message.audioMessage;
        if (audioMessage?.ptt) {
          try {
            await this.handleVoiceMessage(jid, msg);
          } catch (error) {
            this.logger.error(`Ses mesajı işlenirken hata: ${jid}`, error as Error);
          }
          continue;
        }

        const imageMessage = msg.message.imageMessage;
        const documentMessage = msg.message.documentMessage;
        if (imageMessage || documentMessage) {
          try {
            await this.handleFileMessage(jid, msg, imageMessage?.caption || documentMessage?.caption);
          } catch (error) {
            this.logger.error(`Dosya mesajı işlenirken hata: ${jid}`, error as Error);
          }
          continue;
        }

        const text =
          msg.message.conversation || msg.message.extendedTextMessage?.text || '';

        if (!text) continue;

        try {
          await this.handleIncomingMessage(jid, text, msg.key);
        } catch (error) {
          this.logger.error(`Mesaj işlenirken hata: ${jid}`, error as Error);
        }
      }
    });
  }

  // ------------------------------------------------------------------
  // مدیریت گروه‌ها و کانال‌های مانیتور شده -- خوانده‌شده از دیتابیس
  // ------------------------------------------------------------------

  /**
   * هر ۲ دقیقه یک‌بار اجرا می‌شه (و یک‌بار هم بلافاصله بعد از هر اتصال موفق).
   * جدول MonitoredChannel رو می‌خونه و بسته به `type` هر رکورد (گروه یا
   * کانال)، از API متناظرش (groupAcceptInvite یا newsletterFollow) استفاده
   * می‌کنه. یعنی وقتی مدیر از پنل خودش یه گروه یا کانال جدید اضافه می‌کنه،
   * نیازی به ری‌استارت سرور یا صدا زدن دستی چیزی نیست.
   */
  @Cron('*/2 * * * *')
  async syncMonitoredChannels(): Promise<void> {
    // سوکت هنوز آماده نیست (مثلاً سرور تازه بالا اومده) -- این دور رو رد کن،
    // دور بعدی Cron دوباره تلاش می‌کنه.
    if (!this.sock) return;

    // NEW: فقط رکوردهایی رو برمی‌داریم که یا هنوز هیچ‌وقت امتحان نشدن
    // (nextAttemptAt نال) یا زمان تلاش مجددشون رسیده. این از تلاش کورکورانه
    // و بی‌وقفه هر ۲ دقیقه روی رکوردهایی که مدام fail می‌شن جلوگیری می‌کنه.
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
        // NEW: با موفقیت، شمارنده و زمان تلاش مجدد ریست می‌شن
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
        // NEW: هر بار شکست، retryCount افزایش می‌یابد و nextAttemptAt با
        // فاصله‌ی تصاعدی (exponential backoff) به جلو تنظیم می‌شه. یعنی
        // دیگه هر ۲ دقیقه (فاصله‌ی Cron) بی‌وقفه دوباره امتحان نمی‌شه --
        // بلکه فاصله‌ی امتحان بعدی با هر شکست بیشتر می‌شه.
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

  /**
   * تشخیص می‌ده یه شماره احتمالاً موبایله یا ثابت -- بدون فراخوانی هیچ API
   * واتساپی (فقط بر اساس الگوی رقم‌ها). شماره‌ی موبایل ایران همیشه (بعد از
   * حذف صفر ابتدایی یا کد کشور 98) با رقم ۹ شروع می‌شه و ۱۰ رقم داره.
   * شماره‌ی ثابت هیچ‌وقت اینو نداره (کد شهرهاش با ۹ شروع نمی‌شه).
   *
   * چرا این چک لازمه: شماره‌ی ثابت اصلاً روی واتساپ ثبت‌نام نمی‌شه، پس
   * چک کردنش با onWhatsApp هم بی‌فایده‌ست هم یه درخواست غیرضروری به
   * سرورهای واتساپه -- درخواست‌های غیرضروری زیاد می‌تونه ریسک محدود شدن
   * حساب رو بالا ببره.
   */
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

  /**
   * یه شماره تلفن شخصی رو می‌گیره، تایید می‌کنه که واقعاً روی واتساپ فعاله
   * (با متد onWhatsApp خود Baileys)، و JID واقعی‌ش رو برمی‌گردونه. برخلاف
   * گروه/کانال، هیچ عملیات join/follow واقعی لازم نیست -- فقط باید مطمئن
   * بشیم می‌شه بهش پیام فرستاد.
   */
  private async resolvePersonalContact(identifier: string): Promise<string> {
    if (!this.sock) throw new Error('WhatsApp soketi hazır değil.');

    // اگه از قبل یه JID کامل باشه (نه فقط شماره)، مستقیم استفاده می‌کنیم.
    if (identifier.endsWith('@s.whatsapp.net')) {
      return identifier;
    }

    // فقط رقم‌ها رو نگه می‌داریم و فرمت رو به استاندارد بین‌المللی (بدون
    // صفر ابتدایی، با کد کشور) تبدیل می‌کنیم -- مثلاً ۰۹۱۴۱۹۴۴۷۸۴ ->
    // 989141944784. این تبدیل فرض می‌کنه شماره ایرانیه؛ اگه شماره از قبل
    // با کد کشور (98...) وارد شده باشه، دست‌نخورده می‌مونه.
    //
    // نکته‌ی مهم: عبارت \D در جاوااسکریپت فقط ارقام انگلیسی (0-9) رو
    // "رقم" می‌شناسه -- ارقام فارسی/عربی (۰-۹ و ٠-٩) رو "غیررقم" در نظر
    // می‌گیره و اگه قبل از replace(/\D/g, '') تبدیلشون نکنیم، کل رشته حذف
    // می‌شه و یه شماره‌ی خالی/نامعتبر می‌مونه. برای همین اول این تبدیل رو
    // انجام می‌دیم.
    let digits = identifier
      .replace(/[۰-۹]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d).toString())
      .replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d).toString())
      .replace(/\D/g, '');
    if (digits.startsWith('0')) {
      digits = '98' + digits.slice(1);
    } else if (!digits.startsWith('98')) {
      digits = '98' + digits;
    }

    // onWhatsApp چک می‌کنه این شماره واقعاً روی واتساپ ثبت‌نامه یا نه --
    // بدون این چک، ممکنه بعداً هنگام sendMessage با خطای مبهم مواجه بشیم.
    const results = await this.sock.onWhatsApp(digits);
    if (!results || results.length === 0 || !results[0].exists) {
      throw new Error(`Numara WhatsApp'ta kayıtlı değil: ${identifier}`);
    }

    return results[0].jid ?? `${digits}@s.whatsapp.net`;
  }

  /**
   * یه کانال (Newsletter) رو فالو می‌کنه و JID واقعی‌ش رو برمی‌گردونه.
   * ورودی می‌تونه کد دعوت (بعد از channel/ در لینک) یا JID کامل باشه.
   */
  private async followChannel(identifier: string): Promise<string> {
    if (!this.sock) throw new Error('WhatsApp soketi hazır değil.');

    const metadata = identifier.endsWith('@newsletter')
      ? { id: identifier }
      : await this.sock.newsletterMetadata('invite', identifier);

    await this.sock.newsletterFollow(metadata.id);
    return metadata.id;
  }

  /**
   * به یه گروه می‌پیوندد و JID واقعی‌ش رو برمی‌گردونه. ورودی می‌تونه کد
   * دعوت (بعد از chat.whatsapp.com/ در لینک) یا JID کامل (xxxx@g.us) باشه.
   *
   * نکته‌ی مهم: بعضی گروه‌ها تنظیم "Admin Approval" (تایید مدیر) رو فعال
   * دارن -- در این حالت groupAcceptInvite بلافاصله عضو نمی‌کنه، بلکه یه
   * درخواست عضویت ارسال می‌کنه که باید یکی از ادمین‌های گروه دستی تاییدش
   * کنه. Baileys در این حالت یا خطا throw می‌کنه، یا (بسته به نسخه) یه
   * وضعیت متفاوت برمی‌گردونه. اینجا این حالت رو تشخیص می‌دیم و پیام خطای
   * واضح‌تری می‌دیم تا در ستون lastError به مدیر نمایش داده بشه.
   */
  private async joinGroup(identifier: string): Promise<string> {
    if (!this.sock) throw new Error('WhatsApp soketi hazır değil.');

    if (identifier.endsWith('@g.us')) {
      return identifier;
    }

    try {
      const result = await this.sock.groupAcceptInvite(identifier);

      // بعضی نسخه‌های Baileys در حالت "Admin Approval" به‌جای throw کردن
      // خطا، یه مقدار خالی/نامعتبر یا آبجکت متفاوت (نه رشته‌ی JID) برمی‌گردونن.
      // این چک، اون حالت رو هم پوشش می‌ده.
      if (!result || typeof result !== 'string') {
        throw new Error(
          'Gruba katılım isteği gönderildi fakat onay bekliyor olabilir (Admin Approval açık olabilir).',
        );
      }

      return result;
    } catch (error) {
      // لاگ کامل خطای اصلی (نه فقط message) برای عیب‌یابی دقیق‌تر --
      // خطاهایی مثل "Connection Closed" معمولاً یه statusCode یا output
      // اضافی دارن که در JSON.stringify معمولی دیده نمی‌شه.
      this.logger.error(
        `groupAcceptInvite ham hata detayı: ${JSON.stringify(error, Object.getOwnPropertyNames(error as object))}`,
      );

      // پیام خطای اصلی رو هم نگه می‌داریم تا در صورت نیاز به دیباگ دقیق‌تر،
      // علت واقعی (مثلاً لینک منقضی‌شده، در برابر Admin Approval) قابل تفکیک باشه.
      throw new Error(
        `Gruba katılınamadı (muhtemelen Admin Approval açık): ${(error as Error).message}`,
      );
    }
  }

  /**
   * یه پیام گروه/کانال رو به صف اضافه می‌کنه و (اگه صف در حال حاضر بیکاره)
   * پردازششو شروع می‌کنه. این متد سریع برمی‌گرده (فقط push می‌کنه) -- خود
   * پردازش واقعی در processChannelQueue انجام می‌شه.
   */
  private enqueueChannelMessage(msg: WAMessage): void {
    this.channelMessageQueue.push(msg);
    void this.processChannelQueue();
  }

  /**
   * صف پیام‌های گروه/کانال رو یکی‌یکی و به‌ترتیب پردازش می‌کنه -- یعنی
   * پیام بعدی فقط بعد از تموم شدن کامل پیام قبلی (شامل فراخوانی مدل و
   * فوروارد نتیجه) شروع می‌شه. isProcessingChannelQueue تضمین می‌کنه که
   * حتی اگه این متد چندبار هم‌زمان صدا زده بشه (از چند پیام ورودی جدید)،
   * فقط یه نسخه از این حلقه در حال اجرا باشه.
   */
  private async processChannelQueue(): Promise<void> {
    if (this.isProcessingChannelQueue) return;
    this.isProcessingChannelQueue = true;

    try {
      while (this.channelMessageQueue.length > 0) {
        const msg = this.channelMessageQueue.shift()!;
        try {
          // await اینجا حیاتیه -- تا این پیام (شامل فراخوانی مدل و
          // فوروارد) کامل تموم نشه، پیام بعدی از صف برداشته نمی‌شه.
          await this.handleChannelMessage(msg);
        } catch (error) {
          this.logger.error(
            `Kanal/grup mesajı işlenirken hata: ${msg.key.remoteJid}`,
            error as Error,
          );
          // خطای یه پیام نباید جلوی پردازش بقیه‌ی صف رو بگیره -- ادامه می‌دیم.
        }
      }
    } finally {
      this.isProcessingChannelQueue = false;
    }
  }

  /**
   * فقط از روی فیلدهای ساختاریافته‌ی استخراج‌شده توسط مدل و یه کد سفارش
   * (از orderNumber دیتابیس)، متن نهایی رو می‌سازه -- این کار همیشه توسط
   * کد انجام می‌شه (نه مدل)، تا ریسک hallucination (تغییر قیمت/وزن یا
   * اختراع اطلاعات) کاملاً حذف بشه. مدل فقط "چی هست" رو تشخیص می‌ده؛ "چطور
   * نمایش داده بشه" رو همین‌جا (نه در سرویس مدل) کد تصمیم می‌گیره، چون
   * اینجاست که هم پیام خام گروه دریافت و ذخیره می‌شه، هم به orderNumber
   * دیتابیس دسترسی داریم.
   */
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

    // لایه‌ی محافظتی اضافی: حتی اگه مدل طبق پرامپت درست عمل نکنه و کلمات
    // مرتبط با تلفن/تماس رو در extra_notes بذاره، اینجا با یه فیلتر ساده
    // (نه وابسته به مدل) حذفش می‌کنیم -- چون هدف اینه که شماره‌ی تماس فقط
    // یه‌بار و فقط از طریق خط ثابت پایین این تابع نمایش داده بشه.
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
   * بار، جایگزینی شماره تلفن، و ذخیره در دیتابیس. منطق برای هر دو نوع یکسانه
   * -- تنها تفاوت گروه و کانال در نحوه‌ی عضویت (بالا) بود، نه در پردازش پیام.
   */
  private async handleChannelMessage(msg: WAMessage): Promise<void> {
    const channelJid = msg.key.remoteJid!;
    const messageId = msg.key.id;

    if (!messageId) return;

    // جلوگیری از پردازش تکراری همون پیام (مثلاً بعد از reconnect که واتساپ
    // پیام‌های اخیر رو دوباره sync می‌کنه).
    const existing = await this.channelMessageRepo.findOne({ where: { messageId } });
    if (existing) return;

    const text =
      msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';

    if (!text) {
      // پیام رسانه‌ای بدون متن -- فعلاً نادیده گرفته می‌شه.
      return;
    }

    this.logger.log(`📩 Yeni mesaj [${channelJid}]: ${text.slice(0, 80)}...`);

    // ذخیره‌ی اولیه‌ی پیام خام -- حتی اگه تحلیل بعدی fail بشه، خود پیام از
    // دست نمی‌ره. این save اولیه، ستون orderNumber (auto-increment) رو هم
    // خودکار پر می‌کنه -- چون این مقدار توسط خود Postgres تولید می‌شه، فقط
    // بعد از یه save واقعی در دسترسه.
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

      // NEW (تستی): به هر شماره‌ای که از متن خام استخراج شده، یه پیام
      // تستی می‌فرستیم -- فقط برای بررسی اینکه resolvePersonalContact و
      // sendMessage درست کار می‌کنن. بعداً باید این رو با متن واقعی
      // (یا شرط دقیق‌تر) جایگزین کرد.
      if (extraction.found_phone_numbers && extraction.found_phone_numbers.length > 0) {
        for (const rawNumber of extraction.found_phone_numbers) {
          // NEW: قبل از هر درخواستی به واتساپ، چک می‌کنیم این شماره اصلاً
          // احتمال داره موبایل باشه یا نه -- شماره‌ی ثابت هیچ‌وقت روی
          // واتساپ نیست، پس چک کردنش هم بی‌فایده‌ست هم یه درخواست اضافه‌ی
          // بی‌دلیل به سرورهای واتساپه.
          if (!this.isLikelyMobileNumber(rawNumber)) {
            this.logger.log(`⏭️ Sabit hat olduğu için atlandı: ${rawNumber}`);
            continue;
          }

          try {
            const customerJid = await this.resolvePersonalContact(rawNumber);
            await this.sendMessage(customerJid, 'این یک پیام تستی از سیستم است.');
            this.logger.log(
              `📤 Test mesajı gönderildi: ${rawNumber} -> ${customerJid}`,
            );
          } catch (testError) {
            this.logger.error(
              `Test mesajı gönderilemedi: ${rawNumber}`,
              testError as Error,
            );
          }
        }
      }

      if (extraction.is_cargo_order) {
        // NEW: کد پیگیری از همون orderNumber ای که در save اولیه تولید شد
        // ساخته می‌شه -- مشتری فقط همین کد رو تلفنی می‌گه.
        const orderCode = `TRB-${record.orderNumber.toString().padStart(5, '0')}`;

        const processedText = this.buildProcessedText(
          extraction,
          CHANNEL_REPLACEMENT_NUMBER,
          orderCode,
        );
        record.processedText = processedText;
        await this.channelMessageRepo.save(record);

        this.logger.log(`✅ Kargo siparişi tespit edildi [${channelJid}] -- kod: ${orderCode}`);

        if (processedText) {
          await this.forwardToAllDestinations(processedText, channelJid);
        }

        // NEW: برخلاف مقصدهای دیتابیس (که متن پردازش‌شده/ساختاریافته رو
        // می‌گیرن)، به شماره‌ی شخصی همون متن خام اصلی + فقط کد پیگیری
        // فرستاده می‌شه -- نه قالب کامل (بار/مسیر/قیمت/...).
        if (this.personalNotifyJid) {
          const personalNotifyText = `${text}\n\nکد پیگیری: ${orderCode}`;
          try {
            await this.sendMessage(this.personalNotifyJid, personalNotifyText);
            this.logger.log(
              `📤 Kişisel bildirim gönderildi: [${channelJid}] -> [${this.personalNotifyJid}]`,
            );
          } catch (personalError) {
            this.logger.error(
              `Kişisel bildirim gönderilemedi: [${channelJid}] -> [${this.personalNotifyJid}]`,
              personalError as Error,
            );
          }
        }
      } else {
        record.processedText = null;
        await this.channelMessageRepo.save(record);
      }
    } catch (error) {
      // اگه تحلیل fail بشه، پیام خام همچنان ذخیره شده -- فقط لاگ می‌کنیم.
      this.logger.error(`Mesaj analiz edilemedi: ${messageId}`, error as Error);
    }
  }

  /**
   * متن پردازش‌شده رو به همه‌ی گروه/کانال‌هایی که در دیتابیس با
   * role=DESTINATION یا role=BOTH ثبت شدن (و قبلاً با موفقیت join/follow
   * شدن) می‌فرسته. ارسال به هر مقصد جدا از بقیه انجام می‌شه -- یعنی اگه
   * ارسال به یکی fail بشه، بقیه‌ی مقصدها همچنان دریافت می‌کنن.
   */
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

      // مقصد رو خود منبع در نظر نگیریم (جلوگیری از حلقه‌ی بازارسال به
      // همون گروهی که پیام ازش اومده، مخصوصاً وقتی یه رکورد role=BOTH داره)
      if (destination.resolvedJid === sourceJid) continue;

      try {
        await this.sendMessage(destination.resolvedJid, text);
        this.logger.log(
          `📤 Mesaj iletildi: [${sourceJid}] -> [${destination.resolvedJid}] (${destination.label ?? destination.identifier})`,
        );
        // فاصله‌ی کوچیک بین ارسال‌های پشت‌سرهم به چند مقصد -- جلوگیری از
        // الگوی burst مشکوک وقتی مقصدهای زیادی ثبت شده باشن.
        await new Promise((resolve) => setTimeout(resolve, 1000));
      } catch (forwardError) {
        // ارسال ناموفق به یه مقصد نباید جلوی ارسال به بقیه‌ی مقصدها رو
        // بگیره -- فقط لاگ می‌کنیم و ادامه می‌دیم.
        this.logger.error(
          `Mesaj iletilemedi: [${sourceJid}] -> [${destination.resolvedJid}]`,
          forwardError as Error,
        );
      }
    }
  }

  // ------------------------------------------------------------------
  // پیام‌های چت عادی (کاربران واقعی، نه گروه/کانال)
  // ------------------------------------------------------------------

  private async handleIncomingMessage(
    jid: string,
    text: string,
    messageKey: proto.IMessageKey,
  ): Promise<void> {
    const mapping = await this.resolveUserFromJid(jid);

    if (!mapping) {
      await this.handleOnboardingMessage(jid, text, messageKey);
      return;
    }

    const { userid, username } = mapping;

    if (this.pendingSelections.has(jid)) {
      await this.handleSelectionReply(jid, text);
      return;
    }

    await this.runCommand(userid, username, text);
  }

  private async runCommand(
    userid: string,
    username: string,
    text: string,
    files: string[] = [],
  ): Promise<void> {
    const req = {
      user: { userid, username },
    };
    // TODO: اتصال به pipeline اصلی پردازش دستورات (functionCallService یا
    // معادلش) -- در نسخه‌ی فعلی این وابستگی از constructor حذف شده بود.
  }

  private async handleOnboardingMessage(
    jid: string,
    text: string,
    messageKey: proto.IMessageKey,
  ): Promise<void> {
    const parts = text.trim().split(/\s+/);

    if (parts.length !== 2) {
      await this.sendMessage(
        jid,
        'Bu numara sisteme kayıtlı değil. Lütfen kullanıcı adınızı ve şifrenizi şu formatta gönderin:\nkullaniciadi sifre',
      );
      return;
    }

    const [username, password] = parts;

    let authResult: { userid: string } | null;
    try {
      authResult = await this.verifyCredentials(username, password);
    } catch (error) {
      this.logger.error(`verifyCredentials hata verdi: ${username}`, error as Error);
      await this.deleteMessage(jid, messageKey);
      await this.sendMessage(jid, 'Giriş sırasında bir hata oluştu. Lütfen tekrar deneyin.');
      return;
    }

    await this.deleteMessage(jid, messageKey);

    if (!authResult) {
      await this.sendMessage(jid, 'Kullanıcı adı veya şifre hatalı. Lütfen tekrar deneyin.');
      return;
    }

    await this.userMappingRepo.upsert(
      { userid: authResult.userid, username, jid },
      ['jid'],
    );

    await this.sendMessage(
      jid,
      `Hoş geldiniz, ${username}! Artık komutlarınızı buradan gönderebilirsiniz.`,
    );
  }

  private async verifyCredentials(
    username: string,
    password: string,
  ): Promise<{ userid: string } | null> {
    const result = await this.authService.validateUser({ password, username });
    if (!result) return null;
    return { userid: result.user.id };
  }

  private async deleteMessage(jid: string, messageKey: proto.IMessageKey): Promise<void> {
    if (!this.sock) return;

    try {
      await this.sock.sendMessage(jid, { delete: messageKey });
    } catch (error) {
      this.logger.warn(`Mesaj silinemedi: ${jid}`, error as Error);
    }
  }

  private parseUserSelectionReply(text: string): number | null {
    const trimmed = text.trim();
    const num = Number(trimmed);

    if (!Number.isNaN(num) && Number.isInteger(num) && trimmed !== '') {
      return num;
    }
    return null;
  }

  private isCancelReply(text: string): boolean {
    const normalized = text.trim().toLowerCase();
    return ['iptal', 'vazgeç', 'hayır'].includes(normalized);
  }

  private async handleVoiceMessage(jid: string, msg: WAMessage): Promise<void> {
    const mapping = await this.resolveUserFromJid(jid);
    if (!mapping) {
      await this.sendMessage(
        jid,
        'Bu numara sisteme kayıtlı değil. Lütfen önce kullanıcı adınızı ve şifrenizi şu formatta gönderin:\nkullaniciadi sifre',
      );
      return;
    }

    if (!this.sock) {
      this.logger.error('WhatsApp soketi hazır değil.');
      return;
    }

    try {
      await this.sendMessage(jid, '🎤 Ses işleniyor...');

      const downloadDir = join(process.cwd(), 'uploads', 'whatsapp-voice', 'downloads');
      const convertedDir = join(process.cwd(), 'uploads', 'whatsapp-voice', 'converted');
      await mkdir(downloadDir, { recursive: true });
      await mkdir(convertedDir, { recursive: true });

      const buffer = (await downloadMediaMessage(
        msg,
        'buffer',
        {},
        { logger: this.logger as any, reuploadRequest: this.sock.updateMediaMessage },
      )) as Buffer;

      const oggPath = join(
        downloadDir,
        `${Date.now()}-${Math.random().toString(36).slice(2)}.ogg`,
      );
      await writeFile(oggPath, buffer);

      const wavPath = join(
        convertedDir,
        `${Date.now()}-${Math.random().toString(36).slice(2)}.wav`,
      );
      await execAsync(`ffmpeg -y -i "${oggPath}" -ar 16000 -ac 1 -c:a pcm_s16le "${wavPath}"`);

      // TODO: اتصال به speechToTextService برای تبدیل wavPath به متن --
      // در نسخه‌ی فعلی این وابستگی از constructor حذف شده بود.
    } catch (error) {
      this.logger.error(`Ses işleme hatası: ${jid}`, error as Error);
      await this.sendMessage(jid, 'Ses işlenirken bir hata oluştu.');
    }
  }

  private async handleFileMessage(
    jid: string,
    msg: WAMessage,
    caption?: string | null,
  ): Promise<void> {
    const mapping = await this.resolveUserFromJid(jid);
    if (!mapping) {
      await this.sendMessage(
        jid,
        'Bu numara sisteme kayıtlı değil. Lütfen önce kullanıcı adınızı ve şifrenizi şu formatta gönderin:\nkullaniciadi sifre',
      );
      return;
    }

    if (!caption?.trim()) {
      await this.sendMessage(
        jid,
        'Lütfen dosya/resimle birlikte ne yapmak istediğinizi de açıklama olarak yazın.',
      );
      return;
    }

    if (!this.sock) {
      this.logger.error('WhatsApp soketi hazır değil.');
      return;
    }

    try {
      const downloadDir = join(process.cwd(), 'uploads', 'whatsapp-files');
      await mkdir(downloadDir, { recursive: true });

      const buffer = (await downloadMediaMessage(
        msg,
        'buffer',
        {},
        { logger: this.logger as any, reuploadRequest: this.sock.updateMediaMessage },
      )) as Buffer;

      const mimetype =
        msg.message?.imageMessage?.mimetype || msg.message?.documentMessage?.mimetype || '';
      const ext = mimetype.split('/')[1]?.split(';')[0] || 'bin';

      const filePath = join(
        downloadDir,
        `${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`,
      );
      await writeFile(filePath, buffer);

      const { userid, username } = mapping;
      await this.runCommand(userid, username, caption.trim(), [filePath]);
    } catch (error) {
      this.logger.error(`Dosya işleme hatası: ${jid}`, error as Error);
      await this.sendMessage(jid, 'Dosya işlenirken bir hata oluştu.');
    }
  }

  private async resolveUserFromJid(
    jid: string,
  ): Promise<{ userid: string; username: string } | null> {
    const row = await this.userMappingRepo.findOne({ where: { jid } });
    if (!row) return null;
    return { userid: row.userid, username: row.username };
  }

  async getJidForUsername(userid: string): Promise<string | null> {
    const row = await this.userMappingRepo.findOne({ where: { userid } });
    return row?.jid ?? null;
  }

  async sendYesNoConfirmation(userId: string, message: string): Promise<void> {
    const jid = await this.getJidForUsername(userId);
    if (!jid) return;

    await this.sendMessage(jid, `${message}\n\n1) Evet\n2) Hayır`);
  }

  async sendSelectionRequest(
    userId: string,
    message: string,
    options: { value: any; label: string }[],
  ): Promise<void> {
    const jid = await this.getJidForUsername(userId);
    if (!jid) return;

    this.pendingSelections.set(jid, { userId, options, page: 0, message });
    await this.sendSelectionPage(jid);
  }

  private async sendSelectionPage(jid: string): Promise<void> {
    const pending = this.pendingSelections.get(jid);
    if (!pending) return;

    const { options, page, message } = pending;
    const pageSize = WhatsappService.SELECTION_PAGE_SIZE;

    const start = page * pageSize;
    const end = start + pageSize;
    const pageOptions = options.slice(start, end);

    const lines = pageOptions.map((option, i) => `${start + i + 1}) ${option.label}`);

    const hasNext = end < options.length;
    const hasPrev = page > 0;

    const navHints: string[] = [];
    if (hasNext) {
      navHints.push(`'devam' yazarak sonraki ${Math.min(pageSize, options.length - end)} seçeneği görün`);
    }
    if (hasPrev) {
      navHints.push(`'geri' yazarak önceki sayfaya dönün`);
    }
    navHints.push(`İptal etmek için 'iptal' yazın`);

    const text = [
      page === 0 ? message : null,
      lines.join('\n'),
      navHints.join('\n'),
    ]
      .filter(Boolean)
      .join('\n\n');

    await this.sendMessage(jid, text);
  }

  private async handleSelectionReply(jid: string, text: string): Promise<void> {
    const pending = this.pendingSelections.get(jid);
    if (!pending) return;

    const normalized = text.trim().toLowerCase();
    const pageSize = WhatsappService.SELECTION_PAGE_SIZE;

    if (this.isCancelReply(text)) {
      this.pendingSelections.delete(jid);
      return;
    }

    if (normalized === 'devam') {
      const nextStart = (pending.page + 1) * pageSize;
      if (nextStart >= pending.options.length) {
        await this.sendMessage(jid, 'Başka seçenek yok.');
        return;
      }
      pending.page += 1;
      await this.sendSelectionPage(jid);
      return;
    }

    if (normalized === 'geri') {
      if (pending.page === 0) {
        await this.sendMessage(jid, 'Zaten ilk sayfadasınız.');
        return;
      }
      pending.page -= 1;
      await this.sendSelectionPage(jid);
      return;
    }

    const selectionNumber = this.parseUserSelectionReply(text);
    if (selectionNumber === null) {
      await this.sendMessage(
        jid,
        `Lütfen listeden bir numara girin, veya 'devam' / 'geri' / 'iptal' yazın.`,
      );
      return;
    }

    const selectedOption = pending.options[selectionNumber - 1];
    if (!selectedOption) {
      await this.sendMessage(jid, 'Geçersiz numara. Lütfen listedeki bir numarayı girin.');
      return;
    }

    this.pendingSelections.delete(jid);
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

  async sendOrUpdateProgress(
    jid: string,
    text: string,
    currentSegment?: number,
    totalSegments?: number,
  ): Promise<void> {
    if (!this.sock) {
      this.logger.error('WhatsApp soketi hazır değil.');
      return;
    }

    const displayText =
      currentSegment && totalSegments
        ? `${this.buildProgressBar(currentSegment, totalSegments)}\n${text}`
        : text;

    const existingKey = this.activeProgressMessages.get(jid);

    if (existingKey) {
      try {
        await this.sock.sendMessage(jid, { text: displayText, edit: existingKey });
        return;
      } catch (error) {
        this.logger.warn(`Mesaj düzenlenemedi, yeni mesaj gönderiliyor: ${jid}`, error as Error);
      }
    }

    const sent = await this.sock.sendMessage(jid, { text: displayText });

    if (sent?.key) {
      this.activeProgressMessages.set(jid, sent.key);
    }
  }

  async finalizeProgress(jid: string, text: string): Promise<void> {
    await this.sendOrUpdateProgress(jid, text);
    this.activeProgressMessages.delete(jid);
  }

  private buildProgressBar(current: number, total: number, barLength: number = 10): string {
    const percent = total > 0 ? Math.round((current / total) * 100) : 0;
    const filledCount = total > 0 ? Math.round((current / total) * barLength) : 0;
    const bar = '█'.repeat(filledCount) + '░'.repeat(barLength - filledCount);
    return `[${bar}] ${percent}%`;
  }
}