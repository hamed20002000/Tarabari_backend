import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ArrayContains, FindOptionsWhere, In, Repository } from 'typeorm';
import { isUUID } from 'class-validator';
import { MonitoredChannel } from '../entities/MonitoredChannel';
import { TelegramMonitoredChannel } from '../entities/TelegramMonitoredChannel';
import { WhatsappChannelMessage } from '../entities/WhatsappChannelMessage';
import { TelegramChannelMessage } from '../entities/TelegramChannelMessage';
import { ChannelMembershipStatus, MonitoredChannelRole, MonitoredChatType } from '../types';
import { TelegramChannelService } from './telegramChannel.service';

export type ChannelPlatform = 'whatsapp' | 'telegram';
export const CHANNEL_PLATFORMS: ChannelPlatform[] = ['whatsapp', 'telegram'];

/** شکل یکسان گروه/کانال برای هر دو پلتفرم. */
export interface ChannelView {
  id: string;
  platform: ChannelPlatform;
  identifier: string | null;
  type: MonitoredChatType;
  role: MonitoredChannelRole;
  label: string | null;
  isActive: boolean;
  isMember: boolean;
  joinRequestPending: boolean;
  membershipStatus: ChannelMembershipStatus;
  lastError: string | null;
  ownerUserIds: string[];
  createdAt: Date;
}

export interface ChannelFilter {
  platform?: ChannelPlatform;
  userId?: string;
  type?: MonitoredChatType;
  role?: MonitoredChannelRole;
}

export interface MessageFilter {
  platform: ChannelPlatform;
  userId?: string;
  search?: string;
  /** شناسه‌ی گروه/کانال: JID واتساپ یا chatId تلگرام. */
  sourceId?: string;
  page: number;
  limit: number;
}

type ChannelEntity = MonitoredChannel | TelegramMonitoredChannel;

/**
 * نتیجه‌ی ثبت برای همین کاربر:
 *   created            -- گروه/کانال جدید ثبت شد (ربات عضو می‌شه)
 *   owner_added        -- از قبل ثبت شده بود، این کاربر به ثبت‌کننده‌ها اضافه شد
 *   already_registered -- این کاربر قبلاً همین گروه/کانال رو ثبت کرده بود
 */
export type RegisterStatus = 'created' | 'owner_added' | 'already_registered';

/**
 * لینک دعوت واتساپ یا تلگرام رو تشخیص می‌ده و شکل یکتای ذخیره‌اش رو برمی‌گردونه.
 *   واتساپ گروه:  chat.whatsapp.com/XXXX       کانال: whatsapp.com/channel/XXXX
 *   تلگرام:       t.me/username، @username، t.me/+HASH، t.me/joinchat/HASH
 */
function parseChannelLink(
  link: string,
): { platform: ChannelPlatform; identifier: string; type: MonitoredChatType | null } | null {
  const trimmed = link.trim();

  const whatsappGroup = trimmed.match(/chat\.whatsapp\.com\/([A-Za-z0-9]+)/);
  if (whatsappGroup) {
    return { platform: 'whatsapp', identifier: whatsappGroup[1], type: MonitoredChatType.GROUP };
  }
  const whatsappChannel = trimmed.match(/whatsapp\.com\/channel\/([A-Za-z0-9]+)/);
  if (whatsappChannel) {
    return { platform: 'whatsapp', identifier: whatsappChannel[1], type: MonitoredChatType.CHANNEL };
  }

  // نوع گروه/کانال تلگرام تا قبل از عضویت معلوم نیست -- بعد از عضویت پر می‌شه.
  const telegram = TelegramChannelService.normalizeIdentifier(trimmed);
  if (telegram) return { platform: 'telegram', identifier: telegram, type: null };

  return null;
}

/**
 * ثبت و مدیریت گروه/کانال‌های واتساپ و تلگرام با یک API واحد. هر گروه/کانال
 * فقط یک بار عضو می‌شه ولی می‌تونه چند ثبت‌کننده (کاربر transport_backend)
 * داشته باشه؛ پیام‌های بار فقط به همین ثبت‌کننده‌ها اعلان/نمایش داده می‌شن.
 * جدول‌ها جدا می‌مونن چون فیلدهای عضویت دو پلتفرم فرق می‌کنه.
 */
@Injectable()
export class ChannelRegistryService {
  constructor(
    @InjectRepository(MonitoredChannel)
    private readonly whatsappRepo: Repository<MonitoredChannel>,
    @InjectRepository(TelegramMonitoredChannel)
    private readonly telegramRepo: Repository<TelegramMonitoredChannel>,
    @InjectRepository(WhatsappChannelMessage)
    private readonly whatsappMessageRepo: Repository<WhatsappChannelMessage>,
    @InjectRepository(TelegramChannelMessage)
    private readonly telegramMessageRepo: Repository<TelegramChannelMessage>,
  ) {}

  async register(input: {
    link: string;
    userId: string;
    role?: MonitoredChannelRole;
    label?: string;
  }): Promise<{ status: RegisterStatus; created: boolean; channel: ChannelView; warning?: string }> {
    const userId = this.requireUserId(input.userId);
    if (!input.link?.trim()) throw new BadRequestException('link الزامیه.');

    const parsed = parseChannelLink(input.link);
    if (!parsed) {
      throw new BadRequestException(
        'لینک نامعتبره. لینک گروه/کانال واتساپ (chat.whatsapp.com/... یا whatsapp.com/channel/...) یا تلگرام (t.me/... یا @username) باشه.',
      );
    }

    const role = input.role ?? MonitoredChannelRole.SOURCE;
    this.assertRole(role);

    // کانال واتساپ فقط وقتی مقصد می‌شه که بات ادمینش باشه -- رد نمی‌کنیم، فقط هشدار.
    const warning =
      parsed.platform === 'whatsapp' &&
      parsed.type === MonitoredChatType.CHANNEL &&
      role !== MonitoredChannelRole.SOURCE
        ? 'توجه: ارسال پیام در کانال واتساپ فقط اگر بات ادمین آن کانال باشد کار می‌کند.'
        : undefined;

    const repo = this.repo(parsed.platform);
    // رکوردهای قدیمی تلگرام ممکنه با شکل خام لینک ذخیره شده باشن.
    const existing = await repo.findOne({
      where: { identifier: In([parsed.identifier, input.link.trim()]) },
    });

    // قبلاً (احتمالاً توسط کاربر دیگه‌ای) ثبت شده -- دوباره عضو نمی‌شیم، فقط
    // این کاربر هم به ثبت‌کننده‌ها اضافه می‌شه.
    if (existing) {
      const alreadyOwner = existing.ownerUserIds.includes(userId);
      if (!alreadyOwner) {
        existing.ownerUserIds = [...existing.ownerUserIds, userId];
        await repo.save(existing);
      }
      // رکورد غیرفعال (لینک منقضی، حذف ربات از گروه، غیرفعال‌سازی دستی) پیامی
      // نمی‌خونه -- کاربر باید بدونه چرا چیزی دریافت نمی‌کنه.
      const inactiveWarning = existing.isActive
        ? undefined
        : `این گروه/کانال غیرفعاله و پیامی ازش خونده نمی‌شه${existing.lastError ? `: ${existing.lastError}` : '.'}`;
      return {
        status: alreadyOwner ? 'already_registered' : 'owner_added',
        // سازگاری با مصرف‌کننده‌های فعلی (بات transport_backend و transport_front) که created می‌خونن.
        created: false,
        channel: this.toView(parsed.platform, existing),
        warning: inactiveWarning ?? warning,
      };
    }

    const common = {
      identifier: parsed.identifier,
      role,
      label: input.label?.trim() || null,
      ownerUserIds: [userId],
      isActive: true,
    };
    const channel =
      parsed.platform === 'whatsapp'
        ? await this.whatsappRepo.save(
            this.whatsappRepo.create({ ...common, type: parsed.type!, isFollowed: false }),
          )
        : await this.telegramRepo.save(this.telegramRepo.create(common));

    return { status: 'created', created: true, channel: this.toView(parsed.platform, channel), warning };
  }

  async list(filter: ChannelFilter): Promise<ChannelView[]> {
    const where: FindOptionsWhere<ChannelEntity> = {};
    if (filter.type) where.type = filter.type;
    if (filter.role) where.role = filter.role;
    if (filter.userId) where.ownerUserIds = ArrayContains([this.requireUserId(filter.userId)]);

    const platforms = filter.platform ? [filter.platform] : CHANNEL_PLATFORMS;
    const results = await Promise.all(
      platforms.map(async (platform) => {
        const rows = await this.repo(platform).find({ where, order: { createdAt: 'DESC' } });
        return rows.map((row) => this.toView(platform, row));
      }),
    );

    return results.flat().sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  /** فقط همین کاربر از ثبت‌کننده‌ها حذف می‌شه؛ بقیه همچنان اعلان می‌گیرن. */
  async removeOwner(platform: ChannelPlatform, id: string, userId: string): Promise<void> {
    const owner = this.requireUserId(userId);
    const channel = await this.findOrFail(platform, id);
    channel.ownerUserIds = channel.ownerUserIds.filter((existing) => existing !== owner);
    await this.repo(platform).save(channel);
  }

  /** حذف کامل رکورد (برای همه‌ی ثبت‌کننده‌ها). */
  async delete(platform: ChannelPlatform, id: string): Promise<void> {
    await this.findOrFail(platform, id);
    await this.repo(platform).delete(id);
  }

  async setActive(platform: ChannelPlatform, id: string, isActive: boolean): Promise<void> {
    const channel = await this.findOrFail(platform, id);
    // isFollowed/isMember دست نمی‌خوره -- اگه قبلاً عضو شده، عضویت دوباره لازم نیست.
    // ولی رکوردی که عضویتش ناموفق بوده یا ربات ازش حذف شده، دوباره از اول در صف عضویت قرار می‌گیره.
    const retry =
      isActive &&
      [ChannelMembershipStatus.FAILED, ChannelMembershipStatus.REMOVED].includes(channel.membershipStatus);
    await this.repo(platform).update(id, {
      isActive,
      ...(retry
        ? { membershipStatus: ChannelMembershipStatus.QUEUED, lastError: null, retryCount: 0, nextAttemptAt: null }
        : {}),
    });
  }

  async setRole(platform: ChannelPlatform, id: string, role: MonitoredChannelRole): Promise<void> {
    this.assertRole(role);
    await this.findOrFail(platform, id);
    await this.repo(platform).update(id, { role });
  }

  /**
   * پیام‌های بار یک پلتفرم. با userId فقط پیام‌های گروه/کانال‌هایی که همون
   * کاربر ثبت کرده برمی‌گردن.
   */
  async listMessages(filter: MessageFilter) {
    const userId = filter.userId ? this.requireUserId(filter.userId) : undefined;
    const isWhatsapp = filter.platform === 'whatsapp';
    const qb = isWhatsapp
      ? this.whatsappMessageRepo.createQueryBuilder('msg').where('msg.isCargoOrder IS TRUE')
      : this.telegramMessageRepo.createQueryBuilder('msg');
    const sourceColumn = isWhatsapp ? 'msg.channelJid' : 'msg.chatId';

    if (userId) {
      qb.innerJoin(
        isWhatsapp ? MonitoredChannel : TelegramMonitoredChannel,
        'channel',
        `channel.${isWhatsapp ? 'resolvedJid' : 'chatId'} = ${sourceColumn} AND :userId = ANY(channel.ownerUserIds)`,
        { userId },
      );
    }
    if (filter.search?.trim()) {
      qb.andWhere('(msg.rawText ILIKE :search OR msg.code ILIKE :search)', { search: `%${filter.search.trim()}%` });
    }
    if (filter.sourceId?.trim()) {
      qb.andWhere(`${sourceColumn} = :sourceId`, { sourceId: filter.sourceId.trim() });
    }

    const [rows, total] = await qb
      .orderBy('msg.receivedAt', 'DESC')
      .skip((filter.page - 1) * filter.limit)
      .take(filter.limit)
      .getManyAndCount();

    const items = rows.map((row: WhatsappChannelMessage | TelegramChannelMessage) => ({
      id: row.id,
      code: row.code,
      platform: filter.platform,
      sourceId: 'channelJid' in row ? row.channelJid : row.chatId,
      rawText: row.rawText,
      confidence: row.confidence,
      foundPhoneNumbers: row.foundPhoneNumbers,
      receivedAt: row.receivedAt,
    }));

    return { items, total, page: filter.page, limit: filter.limit };
  }

  // ------------------------------------------------------------------

  private repo(platform: ChannelPlatform): Repository<ChannelEntity> {
    return (platform === 'whatsapp' ? this.whatsappRepo : this.telegramRepo) as Repository<ChannelEntity>;
  }

  private async findOrFail(platform: ChannelPlatform, id: string): Promise<ChannelEntity> {
    const channel = isUUID(id) ? await this.repo(platform).findOne({ where: { id } }) : null;
    if (!channel) throw new NotFoundException('گروه/کانال یافت نشد.');
    return channel;
  }

  private toView(platform: ChannelPlatform, row: ChannelEntity): ChannelView {
    const isWhatsapp = row instanceof MonitoredChannel;
    return {
      id: row.id,
      platform,
      identifier: row.identifier,
      type: row.type,
      role: row.role,
      label: row.label,
      isActive: row.isActive,
      isMember: isWhatsapp ? row.isFollowed : (row as TelegramMonitoredChannel).isMember,
      joinRequestPending: isWhatsapp ? false : (row as TelegramMonitoredChannel).joinRequestPending,
      membershipStatus: row.membershipStatus,
      lastError: row.lastError,
      ownerUserIds: row.ownerUserIds,
      createdAt: row.createdAt,
    };
  }

  private requireUserId(userId: string | undefined): string {
    const value = userId?.trim();
    if (!value || !isUUID(value)) {
      throw new BadRequestException('userId (شناسه‌ی کاربر در transport_backend) الزامیه و باید uuid باشه.');
    }
    return value;
  }

  private assertRole(role: MonitoredChannelRole): void {
    if (!Object.values(MonitoredChannelRole).includes(role)) {
      throw new BadRequestException(
        `role باید یکی از این مقادیر باشه: ${Object.values(MonitoredChannelRole).join(', ')}`,
      );
    }
  }
}
