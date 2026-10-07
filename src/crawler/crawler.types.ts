export interface CrawledArticle {
  externalId?: string;
  canonicalUrl?: string;
  title: string;
  description?: string;
  mainContent: string;
  author?: string;
  publishedAt?: Date;
  images: string[];
  tags: string[];
  categories: string[];
  rawMetadata?: Record<string, unknown>;
}
