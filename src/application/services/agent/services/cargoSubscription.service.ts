import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CargoSubscription } from '../entities/CargoSubscription';
import { CargoOrderExtraction } from './aiTools.service';
import { normalizePersianText } from '../utils/persianText';

export interface SubscriberMatch {
  subscriberId: string;
  subscriptionIds: string[];
}

@Injectable()
export class CargoSubscriptionService {
  constructor(
    @InjectRepository(CargoSubscription)
    private readonly subscriptionRepo: Repository<CargoSubscription>,
  ) {}

  /**
   * subscriberهایی که حداقل یکی از ردیف‌های فعالشون با این بار match می‌شه.
   * هر subscriber فقط یک بار برگردونده می‌شه، حتی اگه چند ردیفش match بشه.
   */
  async findMatchingSubscribers(
    extraction: CargoOrderExtraction,
  ): Promise<SubscriberMatch[]> {
    const subscriptions = await this.subscriptionRepo.find({
      where: { isActive: true },
    });

    const matches = new Map<string, string[]>();
    for (const subscription of subscriptions) {
      if (!this.isMatch(subscription, extraction)) continue;
      const ids = matches.get(subscription.subscriberId) ?? [];
      ids.push(subscription.id);
      matches.set(subscription.subscriberId, ids);
    }

    return [...matches].map(([subscriberId, subscriptionIds]) => ({
      subscriberId,
      subscriptionIds,
    }));
  }

  private isMatch(
    subscription: CargoSubscription,
    extraction: CargoOrderExtraction,
  ): boolean {
    return (
      this.fieldMatches(subscription.origins, extraction.origin) &&
      this.fieldMatches(subscription.destinations, extraction.destination) &&
      this.fieldMatches(subscription.cargoTypes, extraction.cargo_type) &&
      this.fieldMatches(subscription.vehicleTypes, extraction.vehicle_type)
    );
  }

  // فیلتر خالی = همه. اگه subscriber فیلتر گذاشته ولی مدل اون فیلد رو
  // استخراج نکرده، match حساب نمی‌شه -- نمی‌دونیم واقعاً مقصد مورد نظرشه.
  // مقایسه به‌صورت «شامل بودن» انجام می‌شه چون خروجی مدل متن آزاده
  // (مثلاً «تهران - میدان آزادی» باید با فیلتر «تهران» match بشه).
  private fieldMatches(filters: string[], value: string | null): boolean {
    const normalizedFilters = filters
      .map(normalizePersianText)
      .filter((f) => f.length > 0);
    if (normalizedFilters.length === 0) return true;
    if (!value) return false;

    const normalizedValue = normalizePersianText(value);
    return normalizedFilters.some((f) => normalizedValue.includes(f));
  }
}
