import { Module } from '@nestjs/common';
import { CampaignsController } from './campaigns.controller';
import { CampaignsService } from './campaigns.service';
import { CampaignStatusService } from './campaign-status.service';
import { AiModule } from '../ai/ai.module';
import { AuditModule } from '../audit/audit.module';
import { CampaignAutomationService } from './campaign-automation.service';

@Module({
  imports: [AiModule, AuditModule],
  controllers: [CampaignsController],
  providers: [CampaignsService, CampaignStatusService, CampaignAutomationService],
  exports: [CampaignStatusService],
})
export class CampaignsModule {}
