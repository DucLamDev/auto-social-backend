import { BRAND_FOOTER_LINES, brandFooter, footerApplies } from './brand-footer';
import { markdownToHtml } from './markdown-html';
import { countChars, detectLanguage, platformContract } from './platform-contract';
import { checkPostLength } from './post-length';
import { apiPostBody, markdownToPlain, postFooter, publishedLength, renderForExtension, renderPostText } from './post-text';

const VI = 'Mình vừa chuyển website sang máy chủ mới và thời gian tải trang giảm hẳn, chia sẻ lại các bước đã làm.';
const EN = 'We moved our website to a new server and page load time dropped a lot, here are the steps we followed.';

describe('platform contract', () => {
  it('derives language, format, limits and hashtag handling from the destination', () => {
    expect(platformContract('nginx-community', { sourceText: VI })).toMatchObject({
      language: 'en', format: 'markdown', hashtagMode: 'tags', titleRequired: true,
    });
    expect(platformContract('tinhte', { sourceText: EN })).toMatchObject({ language: 'vi', format: 'plain', titleRequired: true });
    expect(platformContract('bluesky', { sourceText: VI })).toMatchObject({
      language: 'vi', format: 'plain', maxChars: 300, hashtagMode: 'inline', maxHashtags: 2, titleRequired: false,
    });
    expect(platformContract('voz-forums')).toMatchObject({ language: 'vi', format: 'plain', titleHardLimit: 150 });
    expect(platformContract('threads', { sourceText: EN })).toMatchObject({ language: 'en', maxChars: 500, maxHashtags: 1 });
    expect(platformContract('instagram')).toMatchObject({ hashtagMode: 'appended', maxChars: 2200 });
    expect(platformContract('wordpress')).toMatchObject({ format: 'html', titleRequired: true });
    expect(platformContract('x')).toMatchObject({ counting: 'x', maxChars: 280 });
    // daily.dev's composer is a rich-text editor (plain paragraphs) with 250/20 000 character limits.
    expect(platformContract('daily-dev')).toMatchObject({ format: 'plain', titleRequired: true, titleHardLimit: 250, maxChars: 20_000 });
  });

  it('lets the brand profile override the audience language', () => {
    expect(platformContract('quora', { sourceText: VI }).language).toBe('en');
    expect(platformContract('quora', { sourceText: VI, platformLanguages: { quora: 'vi' } }).language).toBe('vi');
    expect(platformContract('threads', { sourceText: EN, defaultLanguage: 'vi' }).language).toBe('vi');
  });

  it('uses the engine the account posts with for extension destinations', () => {
    expect(platformContract('mastodon-social', { engine: 'mastodon' })).toMatchObject({ format: 'plain', maxChars: 500 });
    expect(platformContract('devto', { engine: 'devto' })).toMatchObject({ format: 'markdown', maxHashtags: 4 });
  });

  it('detects Vietnamese and English text and stays unsure on short or mixed text', () => {
    expect(detectLanguage(VI)).toBe('vi');
    expect(detectLanguage(EN)).toBe('en');
    expect(detectLanguage('VPS mới')).toBe('unknown');
  });

  it('counts X weighted length and graphemes', () => {
    expect(countChars('abc', 'x')).toBe(3);
    expect(countChars('ạ', 'x')).toBe(2);
    expect(countChars('xem https://example.com/a/very/long/path', 'x')).toBe(4 + 23);
    expect(countChars('👍🏽ạ', 'graphemes')).toBe(2);
  });

  it('counts the links X makes from bare domains as 23, and leaves look-alikes as text', () => {
    expect(countChars('xem github.com/vpsttt/auto-social-backend', 'x')).toBe(4 + 23);
    expect(countChars('github.com', 'x')).toBe(23);
    expect(countChars('www.vpsttt.vn', 'x')).toBe(23);
    expect(countChars('vpsttt.vn/blog/bai-viet-rat-dai-ve-vps', 'x')).toBe(23);
    // Country-code domains without a subdomain or path are not linked by X.
    expect(countChars('vpsttt.vn', 'x')).toBe(9);
    expect(countChars('Node.js, socket.io, README.md, config.yml', 'x')).toBe('Node.js, socket.io, README.md, config.yml'.length);
    expect(countChars('hi@vpsttt.com', 'x')).toBe(13);
    // Punctuation after a link is text.
    expect(countChars('Xem https://vpsttt.vn/a.', 'x')).toBe(4 + 23 + 1);
  });

  it('counts Mastodon links as 23 whatever their length, and everything else as graphemes', () => {
    const long = 'https://vpsttt.vn/blog/huong-dan-chuyen-website-sang-vps-nvme-tung-buoc';
    expect(countChars(`Đọc 👍🏽 ${long}`, 'mastodon')).toBe(4 + 2 + 23);
    expect(countChars('https://a.vn', 'mastodon')).toBe(23);
    expect(countChars(`(${long}).`, 'mastodon')).toBe(1 + 23 + 2);
    // Mastodon only shortens links with a protocol.
    expect(countChars('vpsttt.vn/blog', 'mastodon')).toBe(14);
    expect(platformContract('mastodon')).toMatchObject({ counting: 'mastodon', maxChars: 500 });
    expect(platformContract('vivaldi-social')).toMatchObject({ counting: 'mastodon', maxChars: 500 });
    expect(platformContract('mastodon-social')).toMatchObject({ counting: 'mastodon', maxChars: 500 });
    expect(platformContract('bluesky').counting).toBe('graphemes');
  });

  it('knows the Lemmy title limit', () => {
    expect(platformContract('lemmy-world')).toMatchObject({ titleRequired: true, titleMaxChars: 200, titleHardLimit: 200 });
  });
});

describe('post text rendering', () => {
  it('turns Markdown into clean plain paragraphs', () => {
    expect(markdownToPlain('## Bước 1\n\n**Cài** gói `nginx` theo [hướng dẫn](https://nginx.org/docs) và *kiểm tra*.\n\n- một\n* hai\n\n---\n\n```\nnginx -t\n```'))
      .toBe('Bước 1\n\nCài gói nginx theo hướng dẫn (https://nginx.org/docs) và kiểm tra.\n\n• một\n• hai\n\nnginx -t');
    expect(markdownToPlain('Xem [https://vpsttt.com](https://vpsttt.com) và snake_case_name')).toBe('Xem https://vpsttt.com và snake_case_name');
  });

  it('keeps forum tags out of the body and localizes the source line', () => {
    const forum = platformContract('voz-forums');
    expect(renderPostText({ title: null, body: '**Dòng đầu**\nDòng hai', hashtags: ['vps'] }, forum, 'https://vpsttt.com/x'))
      .toEqual({ title: 'Dòng đầu', body: 'Dòng đầu\nDòng hai\n\nNguồn: https://vpsttt.com/x' });
    expect(renderPostText({ title: 'Title', body: EN, hashtags: [] }, platformContract('nginx-community'), 'https://vpsttt.com/x').body)
      .toBe(`${EN}\n\nSource: https://vpsttt.com/x`);
  });

  it('adds only missing inline hashtags and never pushes a post over its limit', () => {
    const bluesky = platformContract('bluesky', { sourceText: VI });
    expect(renderPostText({ title: null, body: `${VI} #vps`, hashtags: ['VPS', 'linux', 'cloud'] }, bluesky).body)
      .toBe(`${VI} #vps\n\n#linux`);
    const full = 'a'.repeat(295);
    expect(renderPostText({ title: null, body: full, hashtags: ['linux'] }, bluesky).body).toBe(full);
  });

  it('does not repeat the source line when the post already links to its source', () => {
    const mastodon = platformContract('mastodon', { sourceText: VI });
    for (const body of [`${VI} Chi tiết: https://vpsttt.vn/x`, `${VI} Chi tiết: https://www.vpsttt.vn/x/.`, `${VI} (vpsttt.vn/x)`]) {
      expect(renderPostText({ title: null, body, hashtags: [] }, mastodon, 'https://vpsttt.vn/x').body).toBe(body);
    }
    // Another page of the same site is not the source.
    expect(renderPostText({ title: null, body: `${VI} https://vpsttt.vn/x-2`, hashtags: [] }, mastodon, 'https://vpsttt.vn/x').body)
      .toBe(`${VI} https://vpsttt.vn/x-2\n\nNguồn: https://vpsttt.vn/x`);
  });

  it('gives no title to a destination without a title field unless one was written (Quora prints it above the body)', () => {
    const quora = platformContract('quora', { engine: 'quora' });
    expect(quora.titleRequired).toBe(false);
    expect(renderPostText({ title: null, body: `First line\n\n${EN}`, hashtags: [] }, quora).title).toBe('');
    expect(renderForExtension({ title: null, body: `First line\n\n${EN}`, hashtags: [] }, 'quora', 'quora', null))
      .toEqual({ title: '', body: `First line\n\n${EN}` });
    expect(renderPostText({ title: 'A real question?', body: EN, hashtags: [] }, quora).title).toBe('A real question?');
    // Forums and articles still fall back to the first line.
    expect(renderPostText({ title: null, body: `First line\n${EN}`, hashtags: [] }, platformContract('nginx-community')).title).toBe('First line');
  });

  it('cuts titles only where the destination has a known limit', () => {
    const long = 'Tiêu đề rất dài '.repeat(20).trim();
    expect([...renderPostText({ title: long, body: VI, hashtags: [] }, platformContract('voz-forums')).title].length).toBeLessThanOrEqual(150);
    expect(renderForExtension({ title: long, body: VI, hashtags: [] }, 'slideshare', 'slideshare', null).title).toBe(long);
  });

  it('counts hashtags a connector appends after the body', () => {
    // An English caption: no company footer (that one is counted in the footer tests below).
    const instagram = platformContract('instagram', { sourceText: EN });
    expect(publishedLength({ title: null, body: 'abc', hashtags: ['a', '#b'] }, instagram)).toBe('abc\n\n#a #b'.length);
  });
});

describe('company footer', () => {
  const FOOTER = BRAND_FOOTER_LINES.join('\n');

  it('ends Vietnamese posts on the brand\'s own channels with the footer, below the source line and hashtags', () => {
    const linkedin = platformContract('linkedin', { sourceText: VI });
    expect(renderPostText({ title: null, body: VI, hashtags: ['vps'] }, linkedin, 'https://vpsttt.com/x').body)
      .toBe(`${VI}\n\nNguồn: https://vpsttt.com/x\n\n#vps\n\n${FOOTER}`);
    for (const slug of ['instagram', 'mewe', 'minds', 'medium', 'substack', 'tumblr', 'tiktok', 'eventbrite']) {
      expect(renderPostText({ title: 'Tiêu đề', body: VI, hashtags: [] }, platformContract(slug, { sourceText: VI })).body).toBe(`${VI}\n\n${FOOTER}`);
    }
  });

  it('never puts it on forums, communities, developer sites, short feeds or English posts', () => {
    for (const slug of ['voz-forums', 'tinhte', 'reddit', 'discourse', 'devto', 'stack-overflow', 'quora', 'discord', 'product-hunt', 'x', 'bluesky', 'threads', 'mastodon', 'pixelfed-social']) {
      const contract = platformContract(slug, { sourceText: VI, defaultLanguage: 'vi' });
      expect(footerApplies(contract, 'vi')).toBe(false);
      expect(renderPostText({ title: 'Tiêu đề', body: VI, hashtags: [] }, contract).body).not.toContain('Hotline');
    }
    expect(renderPostText({ title: null, body: EN, hashtags: [] }, platformContract('linkedin', { sourceText: EN })).body).toBe(EN);
    expect(footerApplies({ slug: 'not-in-catalog' }, 'vi')).toBe(false);
  });

  it('is left out rather than pushing a post over its limit, counting the hashtags Instagram appends', () => {
    const linkedin = platformContract('linkedin', { sourceText: VI });
    const long = `${VI} ${'a'.repeat(2850)}`;
    expect(renderPostText({ title: null, body: long, hashtags: [] }, linkedin).body).toBe(long);
    expect(publishedLength({ title: null, body: long, hashtags: [] }, linkedin)).toBeLessThanOrEqual(3000);
    expect(checkPostLength({ title: null, body: long, hashtags: [], platformSlug: 'linkedin' }).over).toBe(false);
    const instagram = platformContract('instagram', { sourceText: VI });
    const caption = `${VI} ${'a'.repeat(1980 - VI.length)}`;
    const withFooter = publishedLength({ title: null, body: caption, hashtags: [] }, instagram);
    expect(withFooter).toBeGreaterThan(2100);
    expect(withFooter).toBeLessThanOrEqual(2200);
    // The same caption with hashtags appended no longer has room for the footer.
    const tags = ['vps', 'cloud', 'linux', 'server', 'hosting'].map((tag) => `${tag}${'x'.repeat(20)}`);
    expect(renderPostText({ title: null, body: caption, hashtags: tags }, instagram).body).toBe(caption);
    expect(publishedLength({ title: null, body: caption, hashtags: tags }, instagram)).toBeLessThanOrEqual(2200);
  });

  it('is never printed twice when the post already carries the hotline', () => {
    const minds = platformContract('minds', { sourceText: VI });
    for (const hotline of ['0328.812.674', '0328 812 674', '0328812674']) {
      const body = `${VI}\nGọi ${hotline} để được tư vấn.`;
      expect(renderPostText({ title: null, body, hashtags: [] }, minds).body).toBe(body);
    }
  });

  it('is one HTML paragraph with real links for HTML fields, and keeps its lines in pasted rich text', () => {
    const html = renderPostText({ title: 'Tiêu đề', body: `<p>${VI}</p>`, hashtags: [] }, platformContract('wordpress', { sourceText: VI })).body;
    expect(html).toContain('<p>🏢 CÔNG TY CỔ PHẦN TẬP ĐOÀN VPSTTT<br>📍Datacenter: VNPT – Viettel – FPT – CMC<br>');
    expect(html).toContain('🌎 Website: <a href="https://vpsttt.com">https://vpsttt.com</a><br>');
    expect(html).toContain('📲 Zalo tư vấn nhanh: <a href="https://zalo.me/vpstttgroup">https://zalo.me/vpstttgroup</a></p>');
    // Medium / Substack / Tumblr: the extension pastes HTML made from the Markdown rendering.
    const markdown = renderPostText({ title: 'Tiêu đề', body: VI, hashtags: [] }, { ...platformContract('medium', { sourceText: VI }), format: 'markdown' }).body;
    const pasted = markdownToHtml(markdown);
    expect(pasted).toContain('</p><p>🏢 CÔNG TY CỔ PHẦN TẬP ĐOÀN VPSTTT<br>📍Datacenter: VNPT – Viettel – FPT – CMC<br>☎ Hotline: 0328.812.674<br>🌎 Website: <a href=');
    expect(pasted).toMatch(/📲 Zalo tư vấn nhanh: <a href="https:\/\/zalo\.me\/vpstttgroup"[^>]*>https:\/\/zalo\.me\/vpstttgroup<\/a><\/p>$/);
  });

  it('is added by API connectors in the form their field takes, and leaves other bodies exactly as written', () => {
    const linkedin = platformContract('linkedin', { sourceText: VI });
    expect(apiPostBody({ title: null, body: `${VI}\n`, hashtags: [] }, linkedin, 'linkedin')).toBe(`${VI}\n\n${FOOTER}`);
    // Blogger's contract follows its extension flow (Markdown), but its API content field is HTML.
    const blogger = platformContract('blogger', { sourceText: VI });
    expect(blogger.format).toBe('markdown');
    expect(apiPostBody({ title: 'T', body: VI, hashtags: [] }, blogger, 'blogger')).toBe(`${VI}\n\n${brandFooter('html')}`);
    const x = platformContract('x', { sourceText: VI });
    expect(apiPostBody({ title: null, body: `${VI}\n`, hashtags: [] }, x, 'x')).toBe(`${VI}\n`);
    expect(apiPostBody({ title: null, body: '  ', hashtags: [] }, linkedin, 'linkedin')).toBe('  ');
  });

  it('is handed to flows that place it themselves', () => {
    expect(postFooter({ title: null, body: VI, hashtags: [] }, platformContract('medium', { sourceText: VI }), 'https://vpsttt.com/x')).toBe(FOOTER);
    expect(postFooter({ title: 'T', body: VI, hashtags: [] }, platformContract('voz-forums'), null)).toBe('');
  });
});
