import { Injectable, OnModuleInit, Logger, Inject, forwardRef } from '@nestjs/common';
import TelegramBot from 'node-telegram-bot-api';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { TelegramLink } from '../entities/TelegramLink';
import { ConversationSession } from '../entities/ConversationSession';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { TelegramLinkCode } from '../entities/TelegramLinkCode';
import { UserService } from '../../user/user.service';
import { UUID } from 'node:crypto';
import { AuthService } from 'src/auth/auth.service';

const execAsync = promisify(exec);

@Injectable()
export class TelegramService implements OnModuleInit {
    private readonly logger = new Logger(TelegramService.name);
    private bot: TelegramBot;

    constructor(
        @InjectDataSource() private readonly dataSource: DataSource,
        private readonly userService: UserService,
        private readonly authService: AuthService
    ) { }

    // متن‌های تشخیص‌داده‌شده از صدا که هنوز منتظر تایید کاربرن
    private pendingTranscriptions = new Map<string, string>();

    // جدید: انتخاب‌های معلق -- وقتی یک generator یک لیست گزینه yield
    // می‌کنه، این‌جا نگه می‌داریم تا وقتی کاربر روی یکی از دکمه‌ها زد،
    // بتونیم اندیس دکمه (که توی callback_data محدود به ۶۴ بایته) رو
    // به value واقعی گزینه ترجمه کنیم
    private pendingSelections = new Map<
        string,
        { userId: string; options: { id: any; title: string }[] }
    >();

    // شناسه‌ی پیام‌هایی که اخیراً پردازش شدن -- برای جلوگیری از پردازش
    // دوباره‌ی همون پیام (مثلاً اگه به‌خاطر قطعی/تاخیر شبکه، تلگرام
    // دوباره deliverش کنه -- که دقیقاً همون چیزی بود که با پینگ بالا
    // (بیش از ۱ ثانیه) بهش برخوردیم)
    private processedMessageIds = new Set<number>();

    onModuleInit() {
        const token = process.env.TELEGRAM_BOT_TOKEN;
        if (!token) {
            this.logger.warn('TELEGRAM_BOT_TOKEN tanımlanmadı -- Telegram bot devre dışı.');
            return;
        }

        this.bot = new TelegramBot(token, { polling: true });

        this.bot.on('message', (msg) => {
            void this.handleMessage(msg).catch((error) => {
                this.logger.error(`Telegram message handler failed: ${error?.message || error}`);
            });
        });
        this.bot.on('callback_query', (query) => {
            void this.handleCallbackQuery(query).catch((error) => {
                this.logger.error(`Telegram callback handler failed: ${error?.message || error}`);
            });
        });

        // برای دیدن دقیق چندبار و چرا اتصال polling قطع می‌شه
        this.bot.on('polling_error', (error: any) => {
            this.logger.error(`Polling hatası: ${error.code} - ${error.message}`);
        });

        this.logger.log('بات تلگرام فعال شد.');
    }

    /**
     * برای AgentGateway لازمه تا بفهمه یک userId، chatId تلگرام‌شده رو
     * داره یا نه -- تا نتیجه رو هم از این طریق بفرسته.
     */
    /**
     * برای مراحل میانی: یک نوار که واقعاً "پر می‌شه" -- با هر بار صدا زده
     * شدن، یکی بیشتر پر می‌شه، ولی سقفش barLength-1 (نه barLength کامل)ه --
     * یعنی تا وقتی finalizeProgress واقعی صدا زده نشه، هیچ‌وقت ۱۰۰٪/کامل
     * نشون نمی‌ده (که گمراه‌کننده می‌بود). چون Math.min سقف رو نگه می‌داره،
     * مهم نیست step چقدر بزرگ بشه یا چندبار صدا زده بشه -- هیچ‌وقت
     * RangeError نمی‌ده.
     */
    private buildFillingBar(step: number, barLength: number = 10): string {
        const filledCount = Math.min(barLength - 1, Math.max(1, step));
        const percent = Math.min(95, Math.round((filledCount / barLength) * 100));
        const bar = '█'.repeat(filledCount) + '░'.repeat(barLength - filledCount);
        return `[${bar}] ${percent}%`;
    }

    /**
     * نوار کامل -- فقط برای پیام نهایی (finalizeProgress) استفاده می‌شه.
     */
    private buildFullBar(barLength: number = 10): string {
        return `[${'█'.repeat(barLength)}] 100%`;
    }

    private activeProgressMessages = new Map<string, number>();

    // شمارنده‌ی انیمیشن -- به‌ازای هر چت جدا (نه global)، فقط برای حس
    // بصری "داره کار می‌کنه" استفاده می‌شه. چون فقط با % (باقیمانده) در
    // buildFillingBar استفاده می‌شه، هیچ‌وقت مهم نیست چقدر بزرگ بشه یا
    // چندبار صدا زده بشه -- امن در برابر هر تعداد فراخوانی/هم‌پوشانی.
    private animationFrames = new Map<string, number>();

    private async safeSendMessage(
        chatId: string,
        text: string,
        options?: TelegramBot.SendMessageOptions,
    ): Promise<TelegramBot.Message | null> {
        if (!this.bot) return null;

        // جدید: Telegram API با متن خالی/undefined خطای "message text is
        // empty" می‌ده و کل پیام گم می‌شه. این معمولاً یعنی یه‌جای بالادست
        // (مثلاً یک generator handler که بدون فیلد message چیزی yield
        // کرده) متن رو فراموش کرده -- به‌جای کرش کردن، یه متن پیش‌فرض
        // می‌فرستیم و warning لاگ می‌کنیم تا بشه منبع واقعی رو پیدا کرد.
        if (!text || !text.trim()) {
            this.logger.warn(
                `safeSendMessage boş/undefined metinle çağrıldı (chatId=${chatId}) -- çağıran tarafta bir yerde .message eksik olabilir.`,
            );
            text = 'İşlem tamamlandı.';
        }

        try {
            return await this.bot.sendMessage(chatId, text, options);
        } catch (error: any) {
            this.logger.error(
                `Telegram sendMessage failed for chatId=${chatId}: ${error?.message || error}`,
            );
            return null;
        }
    }

    /**
     * حس progressbar می‌ده -- اگه از قبل یک پیام "در حال پردازش" برای
     * این چت داریم، همونو ویرایش می‌کنه؛ وگرنه یک پیام جدید می‌سازه.
     * هر بار صدا زده بشه، یک فریم از نوار متحرک نشون می‌ده (خودش داخلی
     * شمارنده رو مدیریت می‌کنه، نیازی نیست فراخوان چیزی حساب کنه).
     */
    async sendOrUpdateProgress(chatId: string, currentOp: string): Promise<void> {
        if (!this.bot) return;

        const frame = (this.animationFrames.get(chatId) ?? 0) + 1;
        this.animationFrames.set(chatId, frame);

        const text = `${this.buildFillingBar(frame)}\n${currentOp}`;

        const existingMessageId = this.activeProgressMessages.get(chatId);

        if (existingMessageId) {
            try {
                await this.bot.editMessageText(text, {
                    chat_id: chatId,
                    message_id: existingMessageId,
                });
            } catch (error) {
                const sent = await this.safeSendMessage(chatId, text);
                if (sent) {
                    this.activeProgressMessages.set(chatId, sent.message_id);
                }
            }
        } else {
            const sent = await this.safeSendMessage(chatId, text);
            if (sent) {
                this.activeProgressMessages.set(chatId, sent.message_id);
            }
        }
    }

    /**
     * وقتی عملیات کامل تموم شد (نتیجه‌ی نهایی) -- همون پیام رو با
     * نتیجه‌ی نهایی و یک نوار پیشرفت کامل ۱۰۰٪ ویرایش می‌کنه (این یکی،
     * برخلاف نوار متحرکِ مراحل میانی، یک نوار واقعاً کامل و معتبره چون
     * دیگه چیزی برای ادامه نیست)، و ردش رو از نقشه‌ها پاک می‌کنه چون
     * دیگه عملیات بعدی باید پیام "در حال پردازش" جدید خودش رو بسازه.
     */
    async finalizeProgress(chatId: string, text: string): Promise<void> {
        const finalText = `${this.buildFullBar()}\n${text}`;
        const existingMessageId = this.activeProgressMessages.get(chatId);

        if (existingMessageId) {
            try {
                await this.bot.editMessageText(finalText, {
                    chat_id: chatId,
                    message_id: existingMessageId,
                });
            } catch (error) {
                await this.safeSendMessage(chatId, finalText);
            }
        } else {
            await this.safeSendMessage(chatId, finalText);
        }

        this.activeProgressMessages.delete(chatId);
        this.animationFrames.delete(chatId);
    }

    async getChatIdForUsername(userid: string): Promise<string | null> {
        const link = await this.dataSource.getRepository(TelegramLink).findOne({
            where: { Userid: userid },
        });
        return link ? link.ChatId : null;
    }

    async sendMessageToChat(chatId: string, text: string): Promise<void> {
        await this.safeSendMessage(chatId, text);
    }

    /**
     * جدید: AgentGateway.sendToolResult این متد رو صدا می‌زنه وقتی
     * data.result === "confirm_required" باشه و options داشته باشه.
     *
     * callback_data روی هر دکمه فقط اندیس گزینه (sel_0, sel_1, ...) رو
     * حمل می‌کنه -- چون callback_data تلگرام محدود به ۶۴ بایته و
     * value واقعی گزینه (مثلاً یک UUID) ممکنه جا نشه. لیست کامل
     * (با value واقعی هر گزینه) موقتاً توی pendingSelections نگه
     * داشته می‌شه تا وقتی کاربر کلیک کرد، اندیس رو به value ترجمه کنیم.
     */
    async sendSelectionRequest(
        userId: string,
        message: string,
        options: { id: any; title: string }[],
    ): Promise<void> {
        const chatId = await this.getChatIdForUsername(userId);
        if (!chatId) return;

        // جدید: بعضی handler ها فقط options رو yield می‌کنن، بدون متن
        // اضافه (چون خودِ گزینه‌ها گویاست) -- در این حالت، به‌جای متن
        // خالی (که Telegram رد می‌کنه) یا fallback عمومی گمراه‌کننده‌ی
        // safeSendMessage ("İşlem tamamlandı" کاملاً نادرسته اینجا،
        // چون هنوز هیچی تموم نشده)، یک متن مخصوص همین context می‌ذاریم.
        const finalMessage = message && message.trim() ? message : 'Lütfen bir seçenek seçin:';

        // جدید: به‌جای یک دکمه در هر ردیف (که با ۲۰ گزینه یعنی ۲۰ ردیف
        // و اسکرول زیاد)، هر ردیف چند دکمه (BUTTONS_PER_ROW تا) داره
        const BUTTONS_PER_ROW = 2;
        const inline_keyboard: TelegramBot.InlineKeyboardButton[][] = [];

        for (let i = 0; i < options.length; i += BUTTONS_PER_ROW) {
            const rowOptions = options.slice(i, i + BUTTONS_PER_ROW);
            inline_keyboard.push(
                rowOptions.map((option, offset) => ({
                    text: option.title,
                    callback_data: `sel_${i + offset}`,
                })),
            );
        }
        inline_keyboard.push([{ text: '❌ İptal', callback_data: 'sel_cancel' }]);

        const sent = await this.safeSendMessage(chatId, finalMessage, {
            reply_markup: { inline_keyboard },
        });

        if (sent) {
            this.pendingSelections.set(chatId, { userId, options });
        }
    }

    /**
     * جدید: AgentGateway.sendToolResult این متد رو صدا می‌زنه وقتی
     * data.result === "confirm_required" باشه ولی options نداشته باشه --
     * یعنی حالت delete_* (تایید ساده‌ی بله/خیر، نه انتخاب از لیست).
     * WhatsApp معادلش sendYesNoConfirmation با شماره‌ی متنیه؛ چون تلگرام
     * دکمه‌ی واقعی داره، همون رو استفاده می‌کنیم.
     */
    async sendYesNoConfirmation(userId: string, message: string): Promise<void> {
        const chatId = await this.getChatIdForUsername(userId);
        if (!chatId) return;

        // جدید: همون مشکل sendSelectionRequest -- اگه handler بدون .message
        // یه تایید ساده yield کرده باشه، safeSendMessage به‌جاش
        // "İşlem tamamlandı." می‌ذاره که اینجا کاملاً گمراه‌کننده‌ست (چون
        // هنوز هیچی تموم نشده، داره سوال می‌پرسه). به‌جاش یه متن مخصوص
        // همین context.
        const finalMessage = message && message.trim() ? message : 'Bu işlemi onaylıyor musunuz?';

        await this.safeSendMessage(chatId, finalMessage, {
            reply_markup: {
                inline_keyboard: [[
                    { text: '✅ Evet', callback_data: 'confirm_delete' },
                    { text: '❌ Hayır', callback_data: 'cancel_delete' },
                ]],
            },
        });
    }

    private async handleMessage(msg: TelegramBot.Message): Promise<void> {
        // اگه این message_id رو قبلاً پردازش کردیم، دوباره پردازشش نکن --
        // این دقیقاً همون محافظتیه که به‌خاطر پینگ بالا (redelivery
        // احتمالی از سمت تلگرام) لازم شد
        if (this.processedMessageIds.has(msg.message_id)) {
            this.logger.debug(`پیام تکراری نادیده گرفته شد: ${msg.message_id}`);
            return;
        }
        this.processedMessageIds.add(msg.message_id);

        // جلوی رشد بی‌نهایت حافظه رو بگیر -- فقط ۵۰۰ تای آخر رو نگه دار
        if (this.processedMessageIds.size > 500) {
            const first = this.processedMessageIds.values().next().value;
            this.processedMessageIds.delete(first);
        }

        const chatId = msg.chat.id.toString();
        const text = msg.text?.trim();

        if (msg.text == "/start") {
            await this.safeSendMessage(chatId, 'Merhaba! Ben Setash Agent botuyum. Hesabınızı bağlamak için şunu yazın: /link kullaniciadiniz parolanız');
            return;
        }

      

        // جدید: پیام حاوی عکس یا فایل -- دانلود می‌کنیم و مسیرش رو
        // به‌عنوان files وارد pipeline می‌کنیم؛ caption همون پیام‌متنیه
        if (msg.photo || msg.document) {
            await this.handleFileMessage(msg, chatId);
            return;
        }

        if (!text) return;

        // دستور ساده‌ی ربط حساب: /link username password
        if (text.startsWith('/link ')) {
            const parts = text.replace('/link ', '').trim().split(/\s+/);
            const [username, password] = parts;
            await this.handleLinkCommand(chatId, username, password, msg.message_id);
            return;
        }

        // متن تایپ‌شده -- چون خود کاربر مستقیم نوشته، نیازی به تایید
        // اضافه (که مخصوص خطای تشخیص صوته) نداره

        await this.processPromptText(chatId, text);
    }

 

    /**
     * پیام حاوی عکس (msg.photo) یا فایل (msg.document) رو دانلود می‌کنه
     * و مسیرش رو به‌عنوان files وارد pipeline می‌کنه. متن همراه فایل
     * (caption) به‌عنوان prompt استفاده می‌شه -- بدون caption، پیام رو
     * پردازش نمی‌کنیم چون RunFunctionCalling/segmentation به متن نیاز داره.
     */
    private async handleFileMessage(msg: TelegramBot.Message, chatId: string): Promise<void> {
        const caption = msg.caption?.trim();

        if (!caption) {
            await this.safeSendMessage(
                chatId,
                'Lütfen dosya/resimle birlikte ne yapmak istediğinizi de açıklama (caption) olarak yazın.'
            );
            return;
        }

        try {
            const downloadDir = join(process.cwd(), 'uploads', 'telegram-files');
            await mkdir(downloadDir, { recursive: true });

            // msg.document tek bir dosya; msg.photo ise Telegram'ın aynı
            // resmi farklı çözünürlüklerde gönderdiği bir dizi -- en
            // yüksek çözünürlük her zaman dizinin son elemanıdır.
            const fileId = msg.document
                ? msg.document.file_id
                : msg.photo![msg.photo!.length - 1].file_id;

            const filePath = await this.bot.downloadFile(fileId, downloadDir);

            await this.processPromptText(chatId, caption, [filePath]);
        } catch (error: any) {
            this.logger.error(`Dosya işleme hatası: ${error?.message || error}`);
            await this.safeSendMessage(chatId, 'Dosya işlenirken bir hata oluştu.');
        }
    }


    /**
     * وقتی کاربر روی یکی از دکمه‌های تایید/رد کلیک می‌کنه، این هندلر
     * صدا زده می‌شه (نه handleMessage -- تلگرام این‌ها رو جدا می‌فرسته)
     */
    private async handleCallbackQuery(query: TelegramBot.CallbackQuery): Promise<void> {
        const chatId = query.message?.chat.id.toString();
        if (!chatId || !query.message) return;

        // به تلگرام بگو کلیک دریافت شد (وگرنه دکمه توی UI "در حال بارگذاری" می‌مونه)
        await this.bot.answerCallbackQuery(query.id);

        if (query.data === 'confirm_voice') {
            const text = this.pendingTranscriptions.get(chatId);
            this.pendingTranscriptions.delete(chatId);

            if (!text) {
                await this.bot.editMessageText('Onay süresi dolmuş. Lütfen tekrar ses gönderin.', {
                    chat_id: chatId,
                    message_id: query.message.message_id,
                });
                return;
            }

            await this.bot.editMessageText(`✅ Onaylandı: "${text}"`, {
                chat_id: chatId,
                message_id: query.message.message_id,
            });

            await this.processPromptText(chatId, text);
            return;
        }

        if (query.data === 'cancel_voice') {
            this.pendingTranscriptions.delete(chatId);
            await this.bot.editMessageText('❌ İptal edildi. Lütfen tekrar deneyin.', {
                chat_id: chatId,
                message_id: query.message.message_id,
            });
            return;
        }

        // جدید: کلیک روی یکی از دکمه‌های تایید/رد یک عملیات delete_* معلق.
        // برخلاف sel_*/confirm_voice، اینجا یک pendingXxx Map محلی نداریم --
        // FunctionCallService.pendingConfirmationService از قبل بر اساس
        // userId (نه chatId) این وضعیت رو نگه می‌داره، پس فقط باید
        // chatId رو به userId ترجمه کنیم (از طریق TelegramLink).
        if (query.data === 'confirm_delete' || query.data === 'cancel_delete') {
            const link = await this.dataSource.getRepository(TelegramLink).findOne({
                where: { ChatId: chatId },
            });

            if (!link) {
                await this.bot.editMessageText('Oturum bulunamadı.', {
                    chat_id: chatId,
                    message_id: query.message.message_id,
                });
                return;
            }


            if (query.data === 'cancel_delete') {
                await this.bot.editMessageText('❌ İşlem iptal edildi.', {
                    chat_id: chatId,
                    message_id: query.message.message_id,
                });
                return;
            }

            // NOT: resumePendingConfirmation içeride agentGateway.sendToolResult'ı
            // kendisi çağırır (hem runFinalStep için hem de devam eden
            // segment'ler için) -- gerçek "başarılı/başarısız" cevabı zaten
            // source='telegram' üzerinden sendOrUpdateProgress ile ayrıca gelecek.
            await this.bot.editMessageText('✅ Onaylandı, işleniyor...', {
                chat_id: chatId,
                message_id: query.message.message_id,
            });
            return;
        }

        // جدید: کلیک روی یکی از دکمه‌های انتخاب گزینه (sel_0, sel_1, ...) یا لغو (sel_cancel)
        if (query.data === 'sel_cancel' || query.data?.startsWith('sel_')) {
            const pending = this.pendingSelections.get(chatId);
            this.pendingSelections.delete(chatId);

            if (!pending) {
                await this.bot.editMessageText('Seçim süresi dolmuş.', {
                    chat_id: chatId,
                    message_id: query.message.message_id,
                });
                return;
            }


            if (query.data === 'sel_cancel') {
                await this.bot.editMessageText('❌ İşlem iptal edildi.', {
                    chat_id: chatId,
                    message_id: query.message.message_id,
                });
                return;
            }

            const index = Number(query.data.slice('sel_'.length));
            const selectedOption = pending.options[index];

            if (!selectedOption) {
                await this.bot.editMessageText('Geçersiz seçim.', {
                    chat_id: chatId,
                    message_id: query.message.message_id,
                });
                return;
            }

            await this.bot.editMessageText(`✅ Seçildi: ${selectedOption.title}`, {
                chat_id: chatId,
                message_id: query.message.message_id,
            });

           
        }
    }

    /**
     * منطق مشترک "این متن رو به‌عنوان یک prompt واقعی پردازش کن" --
     * چه از تایپ مستقیم بیاد، چه از تایید یک متن صوتی
     */
    private async processPromptText(chatId: string, text: string, files: string[] = []): Promise<void> {
        const link = await this.dataSource.getRepository(TelegramLink).findOne({
            where: { ChatId: chatId },
        });

        if (!link) {
            await this.safeSendMessage(
                chatId,
                'Hesabınızı bağlamak için önce şunu yazın: /link kullaniciadiniz parolanız'
            );
            return;
        }

        const REVERIFY_WINDOW_MS = 24 * 60 * 60 * 1000;
        const sinceLastVerified = Date.now() - new Date(link.LastVerifiedAt).getTime();

        if (sinceLastVerified > REVERIFY_WINDOW_MS) {
            await this.safeSendMessage(
                chatId,
                'Güvenlik nedeniyle yeniden doğrulama gerekiyor. Lütfen şunu yazın: /link kullaniciadiniz parolanız'
            );
            return;
        }

        // جدید: اگه این کاربر یک انتخاب معلق داره ولی متن معمولی فرستاده
        // (نه دکمه زده)، به‌جای اجرای یک دستور جدید، یادآوری کن که باید
        // از دکمه‌ها استفاده کنه -- وگرنه pendingGenerators توی
        // FunctionCallService برای همیشه معلق می‌مونه
        if (this.pendingSelections.has(chatId)) {
            await this.safeSendMessage(
                chatId,
                'Lütfen yukarıdaki seçeneklerden birine tıklayın veya "İptal" butonuna basın.'
            );
            return;
        }

       
        

        const user = await this.userService.getByUserId(link.Userid);

        const fakeReq = {
            user: {
                userid: user.id,
                username: user.username
            }
        };

        // NOT: "İşleniyor..." mesajı burada AYRICA gönderilmiyor -- RunFunctionCalling
        // başlar başlamaz agentGateway.sendCurrentTool zaten tracked (activeProgressMessages
        // içinde takip edilen) ilk ilerleme mesajını gönderiyor. Burada ayrıca ham bir
        // mesaj göndermek, hiç güncellenmeyen/sonuçlanmayan başıboş bir bubble bırakıyordu.

        try {
        } catch (error: any) {
            await this.safeSendMessage(chatId, `Hata: ${error?.message || 'Bilinmeyen bir hata oluştu.'}`);
        }
    }

    /**
     * فقط از طریق پنل وب (با JWT معتبر) صدا زده می‌شه -- پس username
     * قابل‌اعتماده (از توکن میاد، نه از ورودی دستی کاربر).
     */
    async generateLinkCode(username: string): Promise<{ code: string }> {
        const code = Math.floor(100000 + Math.random() * 900000).toString(); // ۶ رقمی

        await this.dataSource.getRepository(TelegramLinkCode).save({
            Code: code,
            Username: username,
            Used: false,
        });

        return { code };
    }

    private async handleLinkCommand(
        chatId: string,
        username: string,
        password: string,
        messageId: number
    ): Promise<void> {
        if (!username || !password) {
            await this.safeSendMessage(chatId, 'Kullanım: /link kullaniciadi parola');
            return;
        }

        const isValid = await this.authService.validateUser({ password, username });

        try {
            await this.bot.deleteMessage(chatId, messageId);
        } catch (error) {
            // اگه پاک کردن شکست خورد (مثلاً پیام قدیمی‌تر از محدودیت زمانی
            // تلگرامه)، جلوی ادامه‌ی کار رو نگیر
        }

        if (!isValid) {
            await this.safeSendMessage(chatId, 'Kullanıcı adı veya parola hatalı.');
            return;
        }

        const repo = this.dataSource.getRepository(TelegramLink);
        const existing = await repo.findOne({ where: { ChatId: chatId } });

        if (existing) {
            existing.Userid = isValid.user.id;
            // ÖNEMLİ: yeniden doğrulama olduğunda LastVerifiedAt'i de
            // resetlemek gerekiyor -- yoksa 24 saat geçtikten sonra
            // kullanıcı ne kadar tekrar /link yaparsa yapsın hep "yeniden
            // doğrulama gerekiyor" mesajı almaya devam eder (çünkü
            // processPromptText hâlâ eski LastVerifiedAt'e bakıyor).
            existing.LastVerifiedAt = new Date();
            await repo.save(existing);
        } else {
            await repo.save({ Userid: isValid.user.id, ChatId: chatId, LastVerifiedAt: new Date() });
        }

        await this.safeSendMessage(chatId, `Hesabınız "${username}" olarak doğrulandı.`);
    }
}