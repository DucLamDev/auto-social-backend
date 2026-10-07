import { Module } from '@nestjs/common';
import { CampaignsController } from './campaigns.controller';
import { CampaignsService } from './campaigns.service';
import { CampaignStatusService } from './campaign-status.service';

@Module({
  controllers: [CampaignsController],
  providers: [CampaignsService, CampaignStatusService],
  exports: [CampaignStatusService],
})
export class CampaignsModule {}
