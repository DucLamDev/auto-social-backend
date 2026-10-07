import { Module } from '@nestjs/common';
import { ConnectorsModule } from '../connectors/connectors.module';
import { CampaignsModule } from '../campaigns/campaigns.module';
import { PublishJobsController } from './publish-jobs.controller';
import { PublishJobsService } from './publish-jobs.service';
import { PublishedPostsController } from './published-posts.controller';
import { PublishingService } from './publishing.service';

@Module({
  imports: [ConnectorsModule, CampaignsModule],
  controllers: [PublishJobsController, PublishedPostsController],
  providers: [PublishingService, PublishJobsService],
  exports: [PublishingService],
})
export class PublishingModule {}
