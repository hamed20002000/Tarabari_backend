import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { DataSource, EntityManager } from 'typeorm';
import { MonitoredChannel } from '../entities/MonitoredChannel';
import { AccountMonitoredChannelBase } from '../entities/AccountChannelBase';
import { OutboxEvent } from '../entities/OutboxEvent';
import { ChannelMembershipStatus } from '../types';
import { ChannelPlatform } from '../common/channelMonitoring';

export const CHANNEL_MEMBERSHIP_CHANGED = 'channel.membership.changed';

type Platform = ChannelPlatform;
type ChannelRecord = MonitoredChannel | AccountMonitoredChannelBase;

/**
 * قرارداد رویداد channel.membership.changed -- transport_backend با همین
 * ساختار به ثبت‌کننده‌ها (socket / تلگرام / واتساپ) خبر می‌ده.
 */
export interface ChannelMembershipChangedEvent {
  eventId: string;
  platform: Platform;
  channelId: string;
  identifier: string | null;
  label: string | null;
  type: string;
  status: ChannelMembershipStatus;
  previousStatus: ChannelMembershipStatus | null;
  reason: string | null;
  ownerUserIds: string[];
  occurredAt: string;
}

/**
 * تغییر وضعیت عضویت گروه/کانال رو ذخیره می‌کنه و -- فقط وقتی وضعیت واقعاً
 * عوض شده -- رویداد channel.membership.changed رو در همون تراکنش در outbox
 * ثبت می‌کنه (Outbox Pattern)؛ پس یا هر دو انجام می‌شن یا هیچ‌کدوم.
 */
@Injectable()
export class ChannelMembershipService {
  private readonly logger = new Logger(ChannelMembershipService.name);

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /**
   * بقیه‌ی فیلدهای channel (isMember، lastError و ...) باید قبل از صدا زدن
   * تنظیم شده باشن -- همه با هم ذخیره می‌شن.
   */
  async transition(
    platform: Platform,
    channel: ChannelRecord,
    status: ChannelMembershipStatus,
    reason: string | null = null,
  ): Promise<void> {
    const previousStatus = channel.membershipStatus ?? null;
    channel.membershipStatus = status;

    await this.dataSource.transaction(async (manager) => {
      // channel نمونه‌ی entity همون پلتفرمه -- جدولش از روی کلاسش معلوم می‌شه.
      await manager.save(channel);
      if (previousStatus !== status) {
        await this.insertEvent(manager, platform, channel, previousStatus, reason, channel.ownerUserIds);
      }
    });

    if (previousStatus !== status) {
      this.logger.log(`وضعیت عضویت ${platform} ${channel.identifier}: ${previousStatus} -> ${status}`);
    }
  }

  /**
   * وضعیت فعلی رو فقط به کاربرهای مشخص‌شده اعلام می‌کنه -- مثلاً وقتی
   * ثبت‌کننده‌های یک رکورد تکراری به رکورد اصلی منتقل می‌شن.
   */
  async announce(platform: Platform, channel: ChannelRecord, userIds: string[]): Promise<void> {
    if (userIds.length === 0) return;
    await this.dataSource.transaction((manager) =>
      this.insertEvent(manager, platform, channel, null, channel.lastError, userIds),
    );
  }

  private async insertEvent(
    manager: EntityManager,
    platform: Platform,
    channel: ChannelRecord,
    previousStatus: ChannelMembershipStatus | null,
    reason: string | null,
    ownerUserIds: string[],
  ): Promise<void> {
    // گروه/کانالی که کسی ثبتش نکرده (مثلاً رکوردهای قدیمی) -- به کسی خبر داده نمی‌شه.
    if (ownerUserIds.length === 0) return;

    const payload: ChannelMembershipChangedEvent = {
      eventId: randomUUID(),
      platform,
      channelId: channel.id,
      identifier: channel.identifier,
      label: channel.label,
      type: channel.type,
      status: channel.membershipStatus,
      previousStatus,
      reason,
      ownerUserIds,
      occurredAt: new Date().toISOString(),
    };

    await manager.insert(OutboxEvent, {
      eventType: CHANNEL_MEMBERSHIP_CHANGED,
      payload: payload as unknown as Record<string, unknown>,
    });
  }
}
