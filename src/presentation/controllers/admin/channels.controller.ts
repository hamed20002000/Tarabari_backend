import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  CHANNEL_PLATFORMS,
  ChannelPlatform,
  ChannelRegistryService,
} from 'src/application/services/agent/services/channelRegistry.service';
import { MonitoredChannelRole, MonitoredChatType } from 'src/application/services/agent/types';

function parsePlatform(value: string | undefined, required: true): ChannelPlatform;
function parsePlatform(value: string | undefined, required?: false): ChannelPlatform | undefined;
function parsePlatform(value: string | undefined, required = false): ChannelPlatform | undefined {
  if (!value && !required) return undefined;
  if (!CHANNEL_PLATFORMS.includes(value as ChannelPlatform)) {
    throw new BadRequestException(`platform باید یکی از این مقادیر باشه: ${CHANNEL_PLATFORMS.join(', ')}`);
  }
  return value as ChannelPlatform;
}

/**
 * API واحد گروه/کانال‌های واتساپ، تلگرام، بله و روبیکا -- فقط transport_backend صداش
 * می‌زنه (InternalApiKeyGuard). userId همون User.id در transport_backend هست.
 */
@Controller('api/channels')
export class ChannelsController {
  constructor(private readonly registry: ChannelRegistryService) {}

  /**
   * ثبت گروه/کانال -- پلتفرم از روی لینک تشخیص داده می‌شه. status در جواب:
   * created (ثبت جدید)، owner_added (از قبل بود، این کاربر اضافه شد) یا
   * already_registered (این کاربر قبلاً ثبتش کرده بود).
   * مثال: POST /api/channels  { "link": "https://t.me/xxx", "userId": "<uuid>" }
   */
  @Post()
  register(
    @Body() body: { link: string; userId: string; role?: MonitoredChannelRole; label?: string },
  ) {
    return this.registry.register(body);
  }

  // مثال: GET /api/channels?userId=<uuid>&platform=telegram
  @Get()
  list(
    @Query('platform') platform?: string,
    @Query('userId') userId?: string,
    @Query('type') type?: MonitoredChatType,
    @Query('role') role?: MonitoredChannelRole,
  ) {
    return this.registry.list({ platform: parsePlatform(platform), userId, type, role });
  }

  /**
   * پیام‌های بار یک پلتفرم. با userId فقط پیام‌های گروه/کانال‌های همون کاربر.
   * مثال: GET /api/channels/messages?platform=whatsapp&userId=<uuid>&search=یخچال
   */
  @Get('messages')
  messages(
    @Query('platform') platform: string,
    @Query('userId') userId?: string,
    @Query('search') search?: string,
    @Query('sourceId') sourceId?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.registry.listMessages({
      platform: parsePlatform(platform, true),
      userId,
      search,
      sourceId,
      page: Math.max(1, parseInt(page ?? '1', 10) || 1),
      // سقف ۱۰۰ تا کسی کل جدول رو یک‌جا نخواد.
      limit: Math.min(100, Math.max(1, parseInt(limit ?? '20', 10) || 20)),
    });
  }

  /**
   * با userId فقط همون کاربر از ثبت‌کننده‌ها حذف می‌شه (بقیه همچنان اعلان
   * می‌گیرن)؛ بدون userId کل رکورد حذف می‌شه.
   */
  @Delete(':platform/:id')
  async remove(
    @Param('platform') platform: string,
    @Param('id') id: string,
    @Query('userId') userId?: string,
  ) {
    const parsed = parsePlatform(platform, true);
    if (userId) await this.registry.removeOwner(parsed, id, userId);
    else await this.registry.delete(parsed, id);
    return { success: true };
  }

  @Patch(':platform/:id/activate')
  async activate(@Param('platform') platform: string, @Param('id') id: string) {
    await this.registry.setActive(parsePlatform(platform, true), id, true);
    return { success: true };
  }

  @Patch(':platform/:id/deactivate')
  async deactivate(@Param('platform') platform: string, @Param('id') id: string) {
    await this.registry.setActive(parsePlatform(platform, true), id, false);
    return { success: true };
  }

  @Patch(':platform/:id/role')
  async updateRole(
    @Param('platform') platform: string,
    @Param('id') id: string,
    @Body() body: { role: MonitoredChannelRole },
  ) {
    await this.registry.setRole(parsePlatform(platform, true), id, body.role);
    return { success: true };
  }
}
