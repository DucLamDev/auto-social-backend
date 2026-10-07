import { Module } from '@nestjs/common';
import { CrawlerService } from './crawler.service';
import { SsrfSafeHttpService } from './ssrf-safe-http.service';

@Module({ providers: [CrawlerService, SsrfSafeHttpService], exports: [CrawlerService, SsrfSafeHttpService] })
export class CrawlerModule {}
