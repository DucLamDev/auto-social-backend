import { Module } from '@nestjs/common';
import { ApplicationConfigModule } from '../config/config.module';
import { CredentialsModule } from '../credentials/credentials.module';
import { DatabaseModule } from '../database/database.module';
import { PublishingModule } from '../publishing/publishing.module';
import { QueueModule } from '../queue/queue.module';
import { PublishWorkerService } from './publish-worker.service';

@Module({ imports: [ApplicationConfigModule, DatabaseModule, CredentialsModule, QueueModule, PublishingModule], providers: [PublishWorkerService] })
export class WorkerModule {}
