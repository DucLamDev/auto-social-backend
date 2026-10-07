import { Module } from '@nestjs/common';
import { CrawlerModule } from '../crawler/crawler.module';
import { ContentSourcesController } from './content-sources.controller';
import { ContentSourcesService } from './content-sources.service';

@Module({ imports: [CrawlerModule], controllers: [ContentSourcesController], providers: [ContentSourcesService] })
export class ContentSourcesModule {}
