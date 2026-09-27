import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import TelegramBot from 'node-telegram-bot-api';
import { SpeechToTextService } from './speechToText.service';
import { RecentIdCache } from '../common/recentIdCache';

@Injectable()
export class TelegramService implements OnModuleInit {
    private readonly logger = new Logger(TelegramService.name);
    private bot: TelegramBot;

    constructor(private readonly speechToTextService: SpeechToTextService) { }

    // شناسه‌ی پیام‌هایی که اخیراً پردازش شدن -- برای جلوگیری از پردازش
    // دوباره‌ی همون پیام (مثلاً اگه به‌خاطر قطعی/تاخیر شبکه، تلگرام
    // دوباره deliverش کنه -- که دقیقاً همون چیزی بود که با پینگ بالا
    // (بیش از ۱ ثانیه) بهش برخوردیم)
    private readonly processedMessageIds = new RecentIdCache<number>(500);

    onModuleInit() {
        const token = process.env.TELEGRAM_BOT_TOKEN;
        if (!token) {
            this.logger.warn('TELEGRAM_BOT_TOKEN تعریف نشده -- بات تلگرام غیرفعاله.');
            return;
        }

        this.bot = new TelegramBot(token, { polling: true });

        this.bot.on('message', (msg) => {
            // بات فقط به چت خصوصی جواب می‌ده -- پیام گروه‌ها نادیده گرفته می‌شن.
            // (گوش دادن به گروه/کانال‌های بار با اکانت کاربری در TelegramChannelService انجام می‌شه.)
            if (msg.chat.type !== 'private') return;
            void this.handleMessage(msg).catch((error) => {
                this.logger.error(`Telegram message handler failed: ${error?.message || error}`);
            });
        });

        // برای دیدن دقیق چندبار و چرا اتصال polling قطع می‌شه
        this.bot.on('polling_error', (error: any) => {
            this.logger.error(`خطای polling: ${error.code} - ${error.message}`);
        });

        this.logger.log('بات تلگرام فعال شد.');
    }

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
                `safeSendMessage با متن خالی/undefined صدا زده شد (chatId=${chatId}) -- احتمالاً یه‌جایی سمت فراخوان .message جا افتاده.`,
            );
            text = 'عملیات انجام شد.';
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

    private async handleMessage(msg: TelegramBot.Message): Promise<void> {
        // اگه این message_id رو قبلاً پردازش کردیم، دوباره پردازشش نکن --
        // این دقیقاً همون محافظتیه که به‌خاطر پینگ بالا (redelivery
        // احتمالی از سمت تلگرام) لازم شد
        if (this.processedMessageIds.has(msg.message_id)) {
            this.logger.debug(`پیام تکراری نادیده گرفته شد: ${msg.message_id}`);
            return;
        }
        this.processedMessageIds.add(msg.message_id);

        const chatId = msg.chat.id.toString();

        if (msg.text === '/start') {
            await this.safeSendMessage(chatId, 'سلام! من بات Setash Agent هستم.');
            return;
        }

        if (msg.voice) {
            await this.handleVoiceMessage(msg.voice, chatId, msg.message_id);
        }
    }

    /** پیام صوتی رو به متن تبدیل می‌کنه و متن رو در جواب همون پیام می‌فرسته. */
    private async handleVoiceMessage(
        voice: TelegramBot.Voice,
        chatId: string,
        messageId: number,
    ): Promise<void> {
        if (voice.duration > SpeechToTextService.MAX_DURATION_SECONDS) {
            await this.safeSendMessage(
                chatId,
                `پیام صوتی طولانی‌تر از ${SpeechToTextService.MAX_DURATION_SECONDS} ثانیه پردازش نمی‌شه.`,
                { reply_to_message_id: messageId },
            );
            return;
        }

        try {
            const chunks: Buffer[] = [];
            for await (const chunk of this.bot.getFileStream(voice.file_id)) {
                chunks.push(Buffer.from(chunk));
            }

            const text = await this.speechToTextService.transcribe(Buffer.concat(chunks), 'ogg');

            await this.safeSendMessage(
                chatId,
                text ? `🎙️ متن پیام صوتی:\n${text}` : 'متنی در پیام صوتی تشخیص داده نشد.',
                { reply_to_message_id: messageId },
            );
        } catch (error: any) {
            this.logger.error(`تبدیل پیام صوتی بات ناموفق بود: ${error?.message || error}`);
            await this.safeSendMessage(chatId, 'هنگام پردازش پیام صوتی خطایی رخ داد.', {
                reply_to_message_id: messageId,
            });
        }
    }
}