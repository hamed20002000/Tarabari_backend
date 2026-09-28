import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import {
  CHANNEL_PLATFORMS,
  ChannelPlatform,
  ChannelRegistryService,
  ChannelView,
} from 'src/application/services/agent/services/channelRegistry.service';
import { MonitoredChannelRole } from 'src/application/services/agent/types';
import { AuthenticatedUser, UserAuth } from 'src/infrastructure/security/userAuth.decorator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class RegisterMyChannelDto {
  @Transform(trim) @IsString() @MinLength(2) @MaxLength(500)
  link!: string;

  @IsOptional() @Transform(trim) @IsString() @MaxLength(100)
  label?: string;
}

class PlatformParams {
  @IsIn(CHANNEL_PLATFORMS)
  platform!: ChannelPlatform;

  @IsString()
  id!: string;
}

type UserRequest = { user: AuthenticatedUser };

// شناسه‌ی کاربرهای دیگری که همین گروه/کانال رو ثبت کردن به فرانت نمی‌ره.
function toUserView({ ownerUserIds: _owners, ...channel }: ChannelView) {
  return channel;
}

/**
 * گروه/کانال‌های واتساپ و تلگرامِ خود کاربر -- مستقیم از فرانت با JWT کاربر.
 * userId همیشه از توکن خونده می‌شه، نه از درخواست؛ پس هر کاربر فقط لیست
 * خودش رو می‌بینه و فقط خودش رو از ثبت‌کننده‌ها حذف می‌کنه.
 */
@Controller('api/my-channels')
@UserAuth()
export class MyChannelsController {
  constructor(private readonly registry: ChannelRegistryService) {}

  @Get()
  async list(@Req() request: UserRequest) {
    return (await this.registry.list({ userId: request.user.userId })).map(toUserView);
  }

  // فقط منبع (source): بار از این گروه/کانال خونده و به همین کاربر پیشنهاد می‌شه.
  @Post()
  async register(@Req() request: UserRequest, @Body() dto: RegisterMyChannelDto) {
    const result = await this.registry.register({
      link: dto.link,
      label: dto.label,
      userId: request.user.userId,
      role: MonitoredChannelRole.SOURCE,
    });
    return { ...result, channel: toUserView(result.channel), warning: result.warning ?? null };
  }

  @Delete(':platform/:id')
  async remove(@Req() request: UserRequest, @Param() params: PlatformParams, @Param('id', ParseUUIDPipe) id: string) {
    await this.registry.removeOwner(params.platform, id, request.user.userId);
    return { success: true };
  }
}
