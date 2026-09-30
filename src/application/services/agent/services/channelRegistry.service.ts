import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ArrayContains, FindOptionsWhere, In, Repository } from 'typeorm';
import { isUUID } from 'class-validator';
import { MonitoredChannel } from '../entities/MonitoredChannel';
import { TelegramMonitoredChannel } from '../entities/TelegramMonitoredChannel';
import { BaleMonitoredChannel } from '../entities/BaleMonitoredChannel';
import { RubikaMonitoredChannel } from '../entities/RubikaMonitoredChannel';
import { WhatsappChannelMessage } from '../entities/WhatsappChannelMessage';
import { TelegramChannelMessage } from '../entities/TelegramChannelMessage';
import { BaleChannelMessage } from '../entities/BaleChannelMessage';
import { RubikaChannelMessage } from '../entities/RubikaChannelMessage';
import { AccountChannelMessageBase, AccountMonitoredChannelBase } from '../entities/AccountChannelBase';
import { ChannelMembershipStatus, MonitoredChannelRole, MonitoredChatType } from '../types';
import { AccountPlatform, CHANNEL_PLATFORMS, ChannelPlatform } from '../common/channelMonitoring';
import { TelegramChannelService } from './telegramChannel.service';
import { BaleChannelService } from './baleChannel.service';
import { RubikaChannelService } from './rubikaChannel.service';

export { CHANNEL_PLATFORMS, ChannelPlatform };

/** شکل یکسان گروه/کانال برای همه‌ی پلتفرم‌ها. */
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
  /** شناسه‌ی گروه/کانال: JID واتساپ یا chatId بقیه‌ی پلتفرم‌ها. */
  sourceId?: string;
  page: number;
  limit: number;
}

type ChannelEntity = MonitoredChannel | AccountMonitoredChannelBase;
type MessageEntity = WhatsappChannelMessage | AccountChannelMessageBase;

// شکل یکتای لینک هر پلتفرم اکانت‌محور؛ لینکی که مال اون پلتفرم نیست null می‌شه.
// تلگرام آخره چون @username بدون دامنه هم مال تلگرام حساب می‌شه.
const ACCOUNT_LINK_NORMALIZERS: [AccountPlatform, (link: string) => string | null][] = [
  ['bale', BaleChannelService.normalizeIdentifier],
  ['rubika', RubikaChannelService.normalizeIdentifier],
  ['telegram', TelegramChannelService.normalizeIdentifier],
];

/**
 * نتیجه‌ی ثبت برای همین کاربر:
 *   created            -- گروه/کانال جدید ثبت شد (ربات عضو می‌شه)
 *   owner_added        -- از قبل ثبت شده بود، این کاربر به ثبت‌کننده‌ها اضافه شد
 *   already_registered -- این کاربر قبلاً همین گروه/کانال رو ثبت کرده بود
 */
export type RegisterStatus = 'created' | 'owner_added' | 'already_registered';

/**
 * لینک دعوت گروه/کانال رو تشخیص می‌ده و شکل یکتای ذخیره‌اش رو برمی‌گردونه.
 *   واتساپ گروه:  chat.whatsapp.com/XXXX       کانال: whatsapp.com/channel/XXXX
 *   تلگرام:       t.me/username، @username، t.me/+HASH، t.me/joinchat/HASH
 *   بله:          ble.ir/username، ble.ir/join/TOKEN
 *   روبیکا:       rubika.ir/username، rubika.ir/joing/HASH، rubika.ir/joinc/HASH
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

  // نوع گروه/کانال این پلتفرم‌ها تا قبل از عضویت معلوم نیست -- بعد از عضویت پر می‌شه.
  for (const [platform, normalize] of ACCOUNT_LINK_NORMALIZERS) {
    const identifier = normalize(trimmed);
    if (identifier) return { platform, identifier, type: null };
  }

  return null;
}

/**
 * ثبت و مدیریت گروه/کانال‌های واتساپ، تلگرام، بله و روبیکا با یک API واحد.
 * هر گروه/کانال فقط یک بار عضو می‌شه ولی می‌تونه چند ثبت‌کننده (کاربر
 * transport_backend) داشته باشه؛ پیام‌های بار فقط به همین ثبت‌کننده‌ها
 * اعلان/نمایش داده می‌شن. هر پلتفرم جدول خودش رو داره.
 */
@Injectable()
export class ChannelRegistryService {
  private readonly channelRepos: Record<ChannelPlatform, Repository<ChannelEntity>>;
  private readonly messageRepos: Record<ChannelPlatform, Repository<MessageEntity>>;

  constructor(
    @InjectRepository(MonitoredChannel) whatsappRepo: Repository<MonitoredChannel>,
    @InjectRepository(TelegramMonitoredChannel) telegramRepo: Repository<TelegramMonitoredChannel>,
    @InjectRepository(BaleMonitoredChannel) baleRepo: Repository<BaleMonitoredChannel>,
    @InjectRepository(RubikaMonitoredChannel) rubikaRepo: Repository<RubikaMonitoredChannel>,
    @InjectRepository(WhatsappChannelMessage) whatsappMessageRepo: Repository<WhatsappChannelMessage>,
    @InjectRepository(TelegramChannelMessage) telegramMessageRepo: Repository<TelegramChannelMessage>,
    @InjectRepository(BaleChannelMessage) baleMessageRepo: Repository<BaleChannelMessage>,
    @InjectRepository(RubikaChannelMessage) rubikaMessageRepo: Repository<RubikaChannelMessage>,
  ) {
    this.channelRepos = {
      whatsapp: whatsappRepo,
      telegram: telegramRepo,
      bale: baleRepo,
      rubika: rubikaRepo,
    } as Record<ChannelPlatform, Repository<ChannelEntity>>;
    this.messageRepos = {
      whatsapp: whatsappMessageRepo,
      telegram: telegramMessageRepo,
      bale: baleMessageRepo,
      rubika: rubikaMessageRepo,
    } as Record<ChannelPlatform, Repository<MessageEntity>>;
  }

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
        'لینک نامعتبره. لینک گروه/کانال واتساپ (chat.whatsapp.com/... یا whatsapp.com/channel/...)، تلگرام (t.me/... یا @username)، بله (ble.ir/...) یا روبیکا (rubika.ir/...) باشه.',
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

    const repo = this.channelRepos[parsed.platform];
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
    const channel = await repo.save(
      repo.create(parsed.platform === 'whatsapp' ? { ...common, type: parsed.type!, isFollowed: false } : common),
    );

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
        const rows = await this.channelRepos[platform].find({ where, order: { createdAt: 'DESC' } });
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
    await this.channelRepos[platform].save(channel);
  }

  /** حذف کامل رکورد (برای همه‌ی ثبت‌کننده‌ها). */
  async delete(platform: ChannelPlatform, id: string): Promise<void> {
    await this.findOrFail(platform, id);
    await this.channelRepos[platform].delete(id);
  }

  async setActive(platform: ChannelPlatform, id: string, isActive: boolean): Promise<void> {
    const channel = await this.findOrFail(platform, id);
    // isFollowed/isMember دست نمی‌خوره -- اگه قبلاً عضو شده، عضویت دوباره لازم نیست.
    // ولی رکوردی که عضویتش ناموفق بوده یا ربات ازش حذف شده، دوباره از اول در صف عضویت قرار می‌گیره.
    const retry =
      isActive &&
      [ChannelMembershipStatus.FAILED, ChannelMembershipStatus.REMOVED].includes(channel.membershipStatus);
    await this.channelRepos[platform].update(id, {
      isActive,
      ...(retry
        ? { membershipStatus: ChannelMembershipStatus.QUEUED, lastError: null, retryCount: 0, nextAttemptAt: null }
        : {}),
    });
  }

  async setRole(platform: ChannelPlatform, id: string, role: MonitoredChannelRole): Promise<void> {
    this.assertRole(role);
    await this.findOrFail(platform, id);
    await this.channelRepos[platform].update(id, { role });
  }

  /**
   * پیام‌های بار یک پلتفرم. با userId فقط پیام‌های گروه/کانال‌هایی که همون
   * کاربر ثبت کرده برمی‌گردن.
   */
  async listMessages(filter: MessageFilter) {
    const userId = filter.userId ? this.requireUserId(filter.userId) : undefined;
    const isWhatsapp = filter.platform === 'whatsapp';
    const qb = this.messageRepos[filter.platform].createQueryBuilder('msg');
    if (isWhatsapp) qb.where('msg.isCargoOrder IS TRUE');
    const sourceColumn = isWhatsapp ? 'msg.channelJid' : 'msg.chatId';

    if (userId) {
      qb.innerJoin(
        this.channelRepos[filter.platform].target as Function,
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

    const items = rows.map((row) => ({
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

  private async findOrFail(platform: ChannelPlatform, id: string): Promise<ChannelEntity> {
    const channel = isUUID(id) ? await this.channelRepos[platform].findOne({ where: { id } }) : null;
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
      isMember: isWhatsapp ? row.isFollowed : row.isMember,
      joinRequestPending: isWhatsapp ? false : row.joinRequestPending,
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
