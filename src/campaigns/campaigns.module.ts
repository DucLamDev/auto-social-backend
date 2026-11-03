import { Module } from '@nestjs/common';
import { CampaignsController } from './campaigns.controller';
import { CampaignsService } from './campaigns.service';
import { CampaignStatusService } from './campaign-status.service';
import { AiModule } from '../ai/ai.module';
import { AuditModule } from '../audit/audit.module';
import { ConnectorsModule } from '../connectors/connectors.module';
import { MediaModule } from '../media/media.module';
import { CampaignAutomationService } from './campaign-automation.service';
import { CampaignAutomationWorkerService } from './campaign-automation-worker.service';

@Module({
  imports: [AiModule, AuditModule, ConnectorsModule, MediaModule],
  controllers: [CampaignsController],
  providers: [CampaignsService, CampaignStatusService, CampaignAutomationService, CampaignAutomationWorkerService],
  exports: [CampaignStatusService, CampaignsService, CampaignAutomationService],
})
export class CampaignsModule {}
