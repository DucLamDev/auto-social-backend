import { CrawlerService } from './crawler.service';
import { SsrfSafeHttpService } from './ssrf-safe-http.service';

describe('CrawlerService', () => {
  const getTextMock: jest.MockedFunction<SsrfSafeHttpService['getText']> = jest.fn();
  const http = { getText: getTextMock } as unknown as SsrfSafeHttpService;
  const crawler = new CrawlerService(http);

  it('extracts the main article and removes scripts/navigation/ads', () => {
    const article = crawler.extractHtml(
      `<html><head><title>Fallback</title><meta name="description" content="Desc"><link rel="canonical" href="/canonical"></head>
       <body><header>Header</header><nav>Menu</nav><article><h1>Hello</h1><script>alert(1)</script><p>Useful text</p><img src="/cover.jpg" alt="cover"><div class="ads">Ad</div></article><footer>Footer</footer></body></html>`,
      'https://example.com/post',
    );
    expect(article.title).toBe('Hello');
    expect(article.canonicalUrl).toBe('https://example.com/canonical');
    expect(article.mainContent).toContain('Useful text');
    expect(article.mainContent).not.toContain('alert(1)');
    expect(article.mainContent).not.toContain('Ad');
    expect(article.images).toEqual(['https://example.com/cover.jpg']);
  });

  it('normalizes RSS and sitemap links', async () => {
    getTextMock.mockResolvedValue({
      body: '<urlset><url><loc>https://example.com/a</loc></url><url><loc>https://example.com/b</loc></url></urlset>',
      finalUrl: 'https://example.com/sitemap.xml',
      contentType: 'application/xml',
    });
    await expect(crawler.discoverFeed('https://example.com/sitemap.xml')).resolves.toEqual([
      'https://example.com/a',
      'https://example.com/b',
    ]);
  });
});
