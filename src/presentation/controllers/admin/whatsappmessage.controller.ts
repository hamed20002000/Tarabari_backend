import {
  Controller,
  Get,
  Param,
  Query,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { WhatsappChannelMessage } from 'src/application/services/agent/entities/WhatsappChannelMessage';

// کد پیگیری به فرم "TRB-00042" ساخته می‌شه (همون الگویی که در
// WhatsappService.buildProcessedText استفاده شده) -- این هلپر برای اضافه
// کردن این فیلد به خروجی API و همچنین parse کردنش موقع جستجو استفاده می‌شه.
function toOrderCode(orderNumber: number): string {
  return `TRB-${orderNumber.toString().padStart(5, '0')}`;
}

// از روی یه رشته‌ی ورودی (که می‌تونه "TRB-00042"، "00042"، یا فقط "42"
// باشه) عدد orderNumber واقعی رو استخراج می‌کنه. اگه چیزی قابل‌تبدیل به
// عدد نبود null برمی‌گردونه.
function parseOrderCode(code: string): number | null {
  const numericPart = code.replace(/\D/g, ''); // فقط رقم‌ها رو نگه می‌داره
  if (!numericPart) return null;
  const parsed = parseInt(numericPart, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

@Controller('api/messages')
export class WhatsappMessageController {
  constructor(
    @InjectRepository(WhatsappChannelMessage)
    private readonly messageRepo: Repository<WhatsappChannelMessage>,
  ) {}

  /**
   * لیست پیام‌ها با فیلتر و صفحه‌بندی.
   *
   * پارامترهای Query:
   *   - search: جستجو در متن خام و متن پردازش‌شده (rawText / processedText)
   *   - code: جستجوی دقیق با کد پیگیری (مثلاً "TRB-00042" یا فقط "42")
   *   - isCargoOrder: فیلتر بر اساس تشخیص سفارش بار ("true" یا "false")
   *   - channelJid: فیلتر بر اساس گروه/کانال مبدا خاص
   *   - page / limit: صفحه‌بندی (پیش‌فرض page=1, limit=20, سقف limit=100)
   *
   * مثال: GET /api/messages?search=شیشه&isCargoOrder=true&page=1&limit=20
   * مثال جستجو با کد: GET /api/messages?code=TRB-00042
   */
  @Get()
  async list(
    @Query('search') search?: string,
    @Query('code') code?: string,
    @Query('isCargoOrder') isCargoOrder?: string,
    @Query('channelJid') channelJid?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const qb = this.messageRepo.createQueryBuilder('msg');

    // جستجو با کد پیگیری -- اولویت با این فیلتره، چون معمولاً دقیق‌ترین
    // راه پیدا کردن یه پیام مشخصه (مثلاً وقتی مشتری تلفنی کد رو می‌گه).
    if (code?.trim()) {
      const orderNumber = parseOrderCode(code);
      if (orderNumber === null) {
        // کد کاملاً نامعتبره (هیچ رقمی توش نیست) -- مطمئناً نتیجه‌ای نداره.
        return { items: [], total: 0, page: 1, limit: 20 };
      }
      qb.andWhere('msg.orderNumber = :orderNumber', { orderNumber });
    }

    // جستجو در محتوا -- هم متن خام (پیامی که از گروه/کانال دریافت شده) و
    // هم متن پردازش‌شده (چیزی که فوروارد شده) رو پوشش می‌ده، چون کاربر
    // ممکنه دنبال کلمه‌ای بگرده که فقط در یکی از این دو باشه.
    if (search?.trim()) {
      qb.andWhere(
        '(msg.rawText ILIKE :search OR msg.processedText ILIKE :search)',
        { search: `%${search.trim()}%` },
      );
    }

    if (isCargoOrder !== undefined) {
      qb.andWhere('msg.isCargoOrder = :isCargoOrder', {
        isCargoOrder: isCargoOrder === 'true',
      });
    }

    if (channelJid?.trim()) {
      qb.andWhere('msg.channelJid = :channelJid', { channelJid: channelJid.trim() });
    }

    const pageNum = Math.max(1, parseInt(page ?? '1', 10) || 1);
    // سقف ۱۰۰ برای limit تا کسی به‌اشتباه یا عمداً کل جدول رو یک‌جا نخواد.
    const limitNum = Math.min(100, Math.max(1, parseInt(limit ?? '20', 10) || 20));

    qb.orderBy('msg.receivedAt', 'DESC')
      .skip((pageNum - 1) * limitNum)
      .take(limitNum);

    const [items, total] = await qb.getManyAndCount();

    return {
      items: items.map((item) => ({
        ...item,
        orderCode: toOrderCode(item.orderNumber),
      })),
      total,
      page: pageNum,
      limit: limitNum,
    };
  }

  /**
   * جزئیات کامل یک پیام با شناسه‌ی UUID داخلی (نه کد پیگیری).
   */
  @Get(':id')
  async findOne(@Param('id') id: string) {
    const item = await this.messageRepo.findOne({ where: { id } });
    if (!item) {
      throw new NotFoundException('پیام مورد نظر یافت نشد.');
    }
    return { ...item, orderCode: toOrderCode(item.orderNumber) };
  }
}