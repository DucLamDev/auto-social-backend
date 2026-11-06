import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { ConnectorsModule } from '../connectors/connectors.module';
import { CampaignsModule } from '../campaigns/campaigns.module';
import { PublishJobsController } from './publish-jobs.controller';
import { PublishJobsService } from './publish-jobs.service';
import { PublishedPostsController } from './published-posts.controller';
import { PublishingService } from './publishing.service';

@Module({
  imports: [AiModule, ConnectorsModule, CampaignsModule],
  controllers: [PublishJobsController, PublishedPostsController],
  providers: [PublishingService, PublishJobsService],
  exports: [PublishingService, PublishJobsService],
})
export class PublishingModule {}
