import { Injectable } from '@nestjs/common';
import * as cheerio from 'cheerio';
import { XMLParser } from 'fast-xml-parser';
import sanitizeHtml from 'sanitize-html';
import { SsrfSafeHttpService } from './ssrf-safe-http.service';
import { CrawledArticle } from './crawler.types';

@Injectable()
export class CrawlerService {
  private readonly xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

  constructor(private readonly http: SsrfSafeHttpService) {}

  async crawlArticle(url: string): Promise<CrawledArticle> {
    const response = await this.http.getText(url, ['text/html', 'application/xhtml+xml']);
    return this.extractHtml(response.body, response.finalUrl);
  }

  async discoverFeed(url: string): Promise<string[]> {
    const response = await this.http.getText(url);
    const parsed = this.xml.parse(response.body) as Record<string, unknown>;
    const rss = parsed.rss as { channel?: { item?: unknown } } | undefined;
    const feed = parsed.feed as { entry?: unknown } | undefined;
    const sitemap = parsed.urlset as { url?: unknown } | undefined;
    const rssItems = this.array(rss?.channel?.item).map((item) => this.stringField(item, 'link'));
    const atomItems = this.array(feed?.entry).map((item) => {
      if (!item || typeof item !== 'object') return undefined;
      const link = (item as Record<string, unknown>).link;
      const first = this.array(link)[0];
      return typeof first === 'object' && first !== null ? this.stringField(first, '@_href') : this.stringValue(link);
    });
    const sitemapItems = this.array(sitemap?.url).map((item) => this.stringField(item, 'loc'));
    return [...new Set([...rssItems, ...atomItems, ...sitemapItems].filter((value): value is string => Boolean(value)))].slice(0, 100);
  }

  async discoverWordPress(siteUrl: string): Promise<CrawledArticle[]> {
    const base = new URL(siteUrl);
    const endpoint = base.pathname.includes('/wp-json/wp/v2/posts')
      ? base
      : new URL('/wp-json/wp/v2/posts?per_page=20&_embed=1', base);
    const response = await this.http.getText(endpoint.toString(), ['application/json']);
    const parsed: unknown = JSON.parse(response.body);
    if (!Array.isArray(parsed)) throw new Error('WordPress posts endpoint returned an unexpected payload');
    return parsed.slice(0, 100).map((raw): CrawledArticle => {
      const post = raw as Record<string, unknown>;
      const rendered = (field: unknown): string =>
        field && typeof field === 'object' && typeof (field as Record<string, unknown>).rendered === 'string'
          ? String((field as Record<string, unknown>).rendered)
          : '';
      const link = typeof post.link === 'string' ? post.link : undefined;
      const date = typeof post.date_gmt === 'string' && !Number.isNaN(Date.parse(post.date_gmt))
        ? new Date(post.date_gmt)
        : undefined;
      return {
        externalId: typeof post.id === 'string' || typeof post.id === 'number' ? String(post.id) : '',
        canonicalUrl: link,
        title: sanitizeHtml(rendered(post.title), { allowedTags: [] }),
        description: sanitizeHtml(rendered(post.excerpt), { allowedTags: [] }),
        mainContent: sanitizeHtml(rendered(post.content), {
          allowedTags: sanitizeHtml.defaults.allowedTags.concat(['img', 'h1', 'h2', 'h3', 'figure', 'figcaption']),
          allowedAttributes: { a: ['href', 'title'], img: ['src', 'alt', 'title'] },
          allowedSchemes: ['http', 'https'],
        }),
        publishedAt: date,
        images: [],
        tags: [],
        categories: [],
        rawMetadata: { wordpressId: post.id },
      };
    });
  }

  extractHtml(html: string, sourceUrl: string): CrawledArticle {
    const $ = cheerio.load(html);
    $('script,style,noscript,iframe,header,footer,nav,aside,form,[role="navigation"],.sidebar,.advertisement,.ads,.related-posts').remove();
    const title = $('meta[property="og:title"]').attr('content') ?? $('h1').first().text().trim() ?? $('title').text().trim();
    const description = $('meta[name="description"]').attr('content') ?? $('meta[property="og:description"]').attr('content');
    const canonicalHref = $('link[rel="canonical"]').attr('href');
    const canonicalUrl = this.absoluteUrl(canonicalHref, sourceUrl) ?? sourceUrl;
    const root = $('article').first().length ? $('article').first() : $('main').first().length ? $('main').first() : $('[role="main"]').first().length ? $('[role="main"]').first() : $('body');
    const clean = sanitizeHtml(root.html() ?? '', {
      allowedTags: sanitizeHtml.defaults.allowedTags.concat(['img', 'h1', 'h2', 'h3', 'figure', 'figcaption']),
      allowedAttributes: { a: ['href', 'title'], img: ['src', 'alt', 'title'], '*': ['class'] },
      allowedSchemes: ['http', 'https'],
      transformTags: { a: sanitizeHtml.simpleTransform('a', { rel: 'nofollow noopener noreferrer' }) },
    });
    const images = root.find('img[src]').toArray().map((element) => this.absoluteUrl($(element).attr('src'), sourceUrl)).filter((value): value is string => Boolean(value));
    const publishedRaw = $('meta[property="article:published_time"]').attr('content') ?? $('time[datetime]').first().attr('datetime');
    const publishedAt = publishedRaw && !Number.isNaN(Date.parse(publishedRaw)) ? new Date(publishedRaw) : undefined;
    const tags = $('meta[property="article:tag"]').map((_index, element) => $(element).attr('content') ?? '').get().filter(Boolean);
    const author = $('meta[name="author"]').attr('content') ?? ($('[rel="author"]').first().text().trim() || undefined);
    return { title: title || canonicalUrl, description, mainContent: clean, author, publishedAt, canonicalUrl, images: [...new Set(images)].slice(0, 20), tags: [...new Set(tags)], categories: [] };
  }

  private absoluteUrl(value: string | undefined, base: string): string | undefined {
    if (!value) return undefined;
    try {
      const url = new URL(value, base);
      return ['http:', 'https:'].includes(url.protocol) ? url.toString() : undefined;
    } catch { return undefined; }
  }

  private array(value: unknown): unknown[] { return value === undefined ? [] : Array.isArray(value) ? value : [value]; }
  private stringField(value: unknown, key: string): string | undefined {
    return value && typeof value === 'object' ? this.stringValue((value as Record<string, unknown>)[key]) : undefined;
  }
  private stringValue(value: unknown): string | undefined { return typeof value === 'string' && value.length ? value : undefined; }
}
