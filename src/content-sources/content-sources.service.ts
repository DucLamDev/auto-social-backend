import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma, SourceType } from '@prisma/client';
import { sha256 } from '../common/utils/crypto.utils';
import { CrawlerService } from '../crawler/crawler.service';
import { CrawledArticle } from '../crawler/crawler.types';
import { PrismaService } from '../database/prisma.service';
import { CreateContentSourceDto } from './dto/create-content-source.dto';

@Injectable()
export class ContentSourcesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crawler: CrawlerService,
  ) {}

  list(ownerId: string) {
    return this.prisma.contentSource.findMany({
      where: { ownerId },
      include: { _count: { select: { articles: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  create(ownerId: string, dto: CreateContentSourceDto) {
    if (dto.type !== SourceType.MANUAL && !dto.url) throw new BadRequestException('URL is required for this source type');
    return this.prisma.contentSource.create({
      data: { ownerId, name: dto.name.trim(), type: dto.type, url: dto.url, config: (dto.config ?? {}) as Prisma.InputJsonObject },
    });
  }

  async fetch(ownerId: string, id: string) {
    const source = await this.prisma.contentSource.findFirstOrThrow({ where: { id, ownerId } });
    if (!source.url || source.type === SourceType.MANUAL) throw new BadRequestException('This source cannot be fetched');
    let articles: CrawledArticle[];
    if (source.type === SourceType.URL) {
      articles = [await this.crawler.crawlArticle(source.url)];
    } else if (source.type === SourceType.WORDPRESS) {
      articles = await this.crawler.discoverWordPress(source.url);
    } else {
      const urls = await this.crawler.discoverFeed(source.url);
      const settled = await Promise.allSettled(urls.slice(0, 20).map((url) => this.crawler.crawlArticle(url)));
      articles = settled.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));
    }
    let inserted = 0;
    let duplicates = 0;
    for (const article of articles) {
      const contentHash = sha256(`${article.title}\n${article.mainContent}`);
      const existing = await this.prisma.sourceArticle.findFirst({
        where: { sourceId: source.id, OR: [{ canonicalUrl: article.canonicalUrl }, { contentHash }] },
        select: { id: true },
      });
      if (existing) { duplicates += 1; continue; }
      await this.prisma.sourceArticle.create({
        data: {
          sourceId: source.id,
          externalId: article.externalId,
          canonicalUrl: article.canonicalUrl,
          title: article.title,
          description: article.description,
          mainContent: article.mainContent,
          author: article.author,
          publishedAt: article.publishedAt,
          images: article.images,
          tags: article.tags,
          categories: article.categories,
          contentHash,
          rawMetadata: (article.rawMetadata ?? {}) as Prisma.InputJsonObject,
        },
      });
      inserted += 1;
    }
    await this.prisma.contentSource.update({ where: { id }, data: { lastFetchedAt: new Date() } });
    return { discovered: articles.length, inserted, duplicates };
  }
}
