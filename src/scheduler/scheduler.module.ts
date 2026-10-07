import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { CampaignsModule } from '../campaigns/campaigns.module';
import { SchedulerService } from './scheduler.service';

@Module({ imports: [ScheduleModule.forRoot(), CampaignsModule], providers: [SchedulerService] })
export class SchedulerModule {}
