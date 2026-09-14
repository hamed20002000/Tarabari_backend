import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  Patch,
  Delete,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  MonitoredChannel,
 
} from 'src/application/services/agent/entities/MonitoredChannel';
import { MonitoredChannelRole,MonitoredChatType } from 'src/application/services/agent/types';

/**
 * لینک دعوت کامل واتساپ رو می‌گیره و بر اساس فرمتش، نوع (گروه یا کانال)
 * و کد شناسایی (identifier) رو استخراج می‌کنه. لینک گروه و کانال ساختار
 * کاملاً متفاوتی دارن، پس نیازی نیست مدیر دستی نوع رو انتخاب کنه.
 *
 *   گروه:   https://chat.whatsapp.com/XXXXXXXXXXXXXXXXXXXXX
 *   کانال:  https://whatsapp.com/channel/0029VaXXXXXXXXXXXXXXXXX
 */
function parseWhatsappInviteLink(
  link: string,
): { identifier: string; type: MonitoredChatType } | null {
  const trimmed = link.trim();

  const groupMatch = trimmed.match(/chat\.whatsapp\.com\/([A-Za-z0-9]+)/);
  if (groupMatch) {
    return { identifier: groupMatch[1], type: MonitoredChatType.GROUP };
  }

  const channelMatch = trimmed.match(/whatsapp\.com\/channel\/([A-Za-z0-9]+)/);
  if (channelMatch) {
    return { identifier: channelMatch[1], type: MonitoredChatType.CHANNEL };
  }

  return null;
}

@Controller('api/baseinfo')
export class BaseinfoController {
  constructor(
    @InjectRepository(MonitoredChannel)
    private readonly channelRepo: Repository<MonitoredChannel>,
  ) {}

  //#region Menus

  // لیست همه‌ی گروه‌ها و کانال‌ها -- می‌شه با type و/یا role فیلتر کرد،
  // مثلاً: GET /api/baseinfo?role=destination برای دیدن فقط مقصدها
  @Get()
  async list(
    @Query('type') type?: MonitoredChatType,
    @Query('role') role?: MonitoredChannelRole,
  ) {
    const where: Record<string, unknown> = {};
    if (type) where.type = type;
    if (role) where.role = role;

    return this.channelRepo.find({
      where,
      order: { createdAt: 'DESC' },
    });
  }

  // افزودن گروه یا کانال جدید -- مدیر لینک دعوت کامل و نقش (role) رو
  // مشخص می‌کنه:
  //   - "source": فقط ازش پیام می‌خونیم (رفتار پیش‌فرض قبلی)
  //   - "destination": فقط پیام‌های پردازش‌شده رو بهش می‌فرستیم
  //   - "both": هم می‌خونیم هم می‌فرستیم
  // عملیات فالو/جوین کردن به‌صورت جداگانه توسط polling در WhatsappService
  // (متد syncMonitoredChannels) انجام می‌شه -- برای هر دو نقش لازمه، چون
  // بات باید عضو باشه چه برای خوندن چه برای فرستادن.
  @Post()
  async add(
    @Body()
    body: {
      link: string;
      role?: MonitoredChannelRole;
      label?: string;
    },
  ) {
    if (!body.link?.trim()) {
      throw new BadRequestException('link الزامیه.');
    }

    const parsed = parseWhatsappInviteLink(body.link);
    if (!parsed) {
      throw new BadRequestException(
        'لینک نامعتبره. باید یک لینک گروه (chat.whatsapp.com/...) یا کانال (whatsapp.com/channel/...) باشه.',
      );
    }

    const role = body.role ?? MonitoredChannelRole.SOURCE;
    if (!Object.values(MonitoredChannelRole).includes(role)) {
      throw new BadRequestException(
        `role باید یکی از این مقادیر باشه: ${Object.values(MonitoredChannelRole).join(', ')}`,
      );
    }

    // نکته: کانال به‌عنوان مقصد فقط وقتی کار می‌کنه که بات ادمین همون
    // کانال باشه (چون فقط ادمین‌ها اجازه‌ی پست کردن در کانال دارن). این
    // هشدار رو در پاسخ برمی‌گردونیم تا مدیر آگاه باشه، ولی رکورد رو رد
    // نمی‌کنیم -- شاید واقعاً ادمین اون کانال باشه.
    const warning =
      parsed.type === MonitoredChatType.CHANNEL &&
      (role === MonitoredChannelRole.DESTINATION || role === MonitoredChannelRole.BOTH)
        ? 'توجه: ارسال پیام در کانال فقط اگر بات ادمین آن کانال باشد کار می‌کند.'
        : undefined;

    const existing = await this.channelRepo.findOne({
      where: { identifier: parsed.identifier },
    });
    if (existing) {
      return {
        success: false,
        message:
          existing.type === MonitoredChatType.GROUP
            ? 'Bu grup zaten ekli.'
            : 'Bu kanal zaten ekli.',
      };
    }

    const channel = this.channelRepo.create({
      identifier: parsed.identifier,
      type: parsed.type,
      role,
      label: body.label ?? null,
      isActive: true,
      isFollowed: false,
    });
    await this.channelRepo.save(channel);

    return { success: true, channel, warning };
  }

  // غیرفعال کردن موقت (بدون حذف کامل رکورد) -- برای هر دو نوع و هر نقشی یکسان کار می‌کنه
  @Patch(':id/deactivate')
  async deactivate(@Param('id') id: string) {
    await this.channelRepo.update(id, { isActive: false });
    return { success: true };
  }

  @Patch(':id/activate')
  async activate(@Param('id') id: string) {
    // isFollowed رو false نمی‌کنیم چون اگه قبلاً فالو/جوین شده، نیازی به
    // فالو/جوین دوباره نیست -- فقط دوباره فعالش می‌کنیم.
    await this.channelRepo.update(id, { isActive: true });
    return { success: true };
  }

  // NEW: تغییر نقش یه رکورد بعد از افزودن (مثلاً یه گروه source بود، حالا
  // می‌خوایم destination هم باشه)
  @Patch(':id/role')
  async updateRole(
    @Param('id') id: string,
    @Body() body: { role: MonitoredChannelRole },
  ) {
    if (!body.role || !Object.values(MonitoredChannelRole).includes(body.role)) {
      throw new BadRequestException(
        `role باید یکی از این مقادیر باشه: ${Object.values(MonitoredChannelRole).join(', ')}`,
      );
    }
    await this.channelRepo.update(id, { role: body.role });
    return { success: true };
  }

  @Delete(':id')
  async remove(@Param('id') id: string) {
    await this.channelRepo.delete(id);
    return { success: true };
  }

  //#endregion
}