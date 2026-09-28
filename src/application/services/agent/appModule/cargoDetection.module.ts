import { Module } from '@nestjs/common';
import { TransportOrderService } from '../services/aiTools.service';
import { SpeechToTextService } from '../services/speechToText.service';
import { CargoPipelineService } from '../services/cargoPipeline.service';
import { ChannelMembershipService } from '../services/channelMembership.service';

// سرویس‌های مشترک تشخیص بار برای واتساپ و تلگرام -- یک نمونه از هر کدوم،
// تا صف مدل و صف تبدیل صدا بین همه یکی باشه.
@Module({
  providers: [TransportOrderService, SpeechToTextService, CargoPipelineService, ChannelMembershipService],
  exports: [TransportOrderService, SpeechToTextService, CargoPipelineService, ChannelMembershipService],
})
export class CargoDetectionModule {}
