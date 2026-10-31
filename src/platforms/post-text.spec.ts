import { countChars, detectLanguage, platformContract } from './platform-contract';
import { markdownToPlain, publishedLength, renderForExtension, renderPostText } from './post-text';

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

  it('cuts titles only where the destination has a known limit', () => {
    const long = 'Tiêu đề rất dài '.repeat(20).trim();
    expect([...renderPostText({ title: long, body: VI, hashtags: [] }, platformContract('voz-forums')).title].length).toBeLessThanOrEqual(150);
    expect(renderForExtension({ title: long, body: VI, hashtags: [] }, 'slideshare', 'slideshare', null).title).toBe(long);
  });

  it('counts hashtags a connector appends after the body', () => {
    const instagram = platformContract('instagram');
    expect(publishedLength({ title: null, body: 'abc', hashtags: ['a', '#b'] }, instagram)).toBe('abc\n\n#a #b'.length);
  });
});
