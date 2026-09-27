import { Module } from '@nestjs/common';
import { TransportOrderService } from '../services/aiTools.service';
import { SpeechToTextService } from '../services/speechToText.service';
import { CargoPipelineService } from '../services/cargoPipeline.service';

// سرویس‌های مشترک تشخیص بار برای واتساپ و تلگرام -- یک نمونه از هر کدوم،
// تا صف مدل و صف تبدیل صدا بین همه یکی باشه.
@Module({
  providers: [TransportOrderService, SpeechToTextService, CargoPipelineService],
  exports: [TransportOrderService, SpeechToTextService, CargoPipelineService],
})
export class CargoDetectionModule {}
