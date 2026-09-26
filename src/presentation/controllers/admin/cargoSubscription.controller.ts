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
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CargoSubscription } from 'src/application/services/agent/entities/CargoSubscription';

interface CargoSubscriptionBody {
  subscriberId?: string;
  label?: string | null;
  origins?: string[];
  destinations?: string[];
  cargoTypes?: string[];
  vehicleTypes?: string[];
  isActive?: boolean;
}

const FILTER_FIELDS = ['origins', 'destinations', 'cargoTypes', 'vehicleTypes'] as const;

// فیلترها باید آرایه‌ای از رشته باشن -- مقادیر خالی/فاصله حذف می‌شن تا
// یه آیتم خالی باعث نشه فیلتر به‌اشتباه «همه» یا «هیچ» حساب بشه.
function pickFilters(body: CargoSubscriptionBody): Partial<CargoSubscription> {
  const result: Partial<CargoSubscription> = {};
  for (const field of FILTER_FIELDS) {
    const value = body[field];
    if (value === undefined) continue;
    if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
      throw new BadRequestException(`${field} باید آرایه‌ای از رشته باشه.`);
    }
    result[field] = value.map((v) => v.trim()).filter((v) => v.length > 0);
  }
  return result;
}

@Controller('api/cargo-subscriptions')
export class CargoSubscriptionController {
  constructor(
    @InjectRepository(CargoSubscription)
    private readonly subscriptionRepo: Repository<CargoSubscription>,
  ) {}

  // مثال: GET /api/cargo-subscriptions?subscriberId=company-42
  @Get()
  async list(@Query('subscriberId') subscriberId?: string) {
    return this.subscriptionRepo.find({
      where: subscriberId ? { subscriberId } : {},
      order: { createdAt: 'DESC' },
    });
  }

  // فیلترهای خالی یا ارسال‌نشده یعنی «همه». مثال:
  //   { "subscriberId": "company-42", "origins": ["تهران"], "destinations": ["مشهد", "تبریز"] }
  @Post()
  async create(@Body() body: CargoSubscriptionBody) {
    if (!body.subscriberId?.trim()) {
      throw new BadRequestException('subscriberId الزامیه.');
    }

    const subscription = this.subscriptionRepo.create({
      subscriberId: body.subscriberId.trim(),
      label: body.label ?? null,
      isActive: body.isActive ?? true,
      ...pickFilters(body),
    });
    return this.subscriptionRepo.save(subscription);
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() body: CargoSubscriptionBody) {
    const subscription = await this.subscriptionRepo.findOne({ where: { id } });
    if (!subscription) throw new NotFoundException('تنظیمات پیدا نشد.');

    if (body.label !== undefined) subscription.label = body.label;
    if (body.isActive !== undefined) subscription.isActive = body.isActive;
    Object.assign(subscription, pickFilters(body));

    return this.subscriptionRepo.save(subscription);
  }

  @Delete(':id')
  async remove(@Param('id') id: string) {
    await this.subscriptionRepo.delete(id);
    return { success: true };
  }
}
