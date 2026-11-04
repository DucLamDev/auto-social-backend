import { platformContract } from './platform-contract';
import { checkPostLength, checkTextLength, contractFor, deliveryEngine, fitToLimit, postLengthMessage } from './post-length';
import { publishedLength, renderPostText } from './post-text';

const SOURCE = 'https://vpsttt.vn/blog/vps-nvme-cho-lap-trinh-vien-viet-nam';
const SENTENCES = [
  'Triển khai VPS NVMe chỉ trong 60 giây, có người hỗ trợ bằng tiếng Việt khi bạn cần.',
  'Ổ NVMe đọc ghi nhanh gấp nhiều lần SSD thường, nên cơ sở dữ liệu và build CI chạy mượt hơn hẳn.',
  'Bạn chọn hệ điều hành, gói cấu hình và vùng đặt máy chủ ngay trên bảng điều khiển.',
  'Sao lưu tự động mỗi ngày giúp bạn yên tâm thử nghiệm mà không sợ mất dữ liệu.',
  'Đội kỹ thuật trực cả cuối tuần, trả lời bằng tiếng Việt trong vài phút qua chat.',
  'Mình đã chuyển ba dự án sang đây.',
  'Bạn đang chạy dự án của mình trên đâu?',
];

/** A Vietnamese Mastodon post of about 545 characters, as the AI wrote it, with closing hashtags. */
function mastodonDraft() {
  return { title: null, body: `${SENTENCES.join(' ')}\n\n#vps #nvme #linux`, hashtags: ['vps', 'nvme', 'linux'] };
}

const graphemes = (text: string) => [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].map(({ segment }) => segment);

describe('checkPostLength and the connector check', () => {
  it('counts what the destination counts: the source line, Mastodon links as 23 and X weights', () => {
    const body = `Xem hướng dẫn tại ${SOURCE}/chi-tiet-tung-buoc-cai-dat`;
    const mastodon = checkPostLength({ title: null, body, hashtags: [], platformSlug: 'mastodon', canonicalUrl: SOURCE });
    // "Xem hướng dẫn tại " (18) + link (23) + "\n\nNguồn: " (9) + link (23).
    expect(mastodon).toEqual({ length: 18 + 23 + 9 + 23, maxChars: 500, over: false, counting: 'mastodon' });
    expect(checkPostLength({ title: null, body: 'ạ'.repeat(141), hashtags: [], platformSlug: 'x' })).toMatchObject({ length: 282, maxChars: 280, over: true });
    expect(checkTextLength('bluesky', '👍🏽'.repeat(300))).toMatchObject({ length: 300, over: false });
    expect(checkTextLength('mastodon', `${'a'.repeat(480)} ${SOURCE}`)).toMatchObject({ length: 504, maxChars: 500, over: true, counting: 'mastodon' });
  });

  it('uses the engine an extension account posts with, and reads it from account settings', () => {
    expect(contractFor({ platformSlug: 'mastodon-social', engine: 'mastodon', body: '' })).toMatchObject({ counting: 'mastodon', maxChars: 500 });
    expect(deliveryEngine({ delivery: 'extension', extensionEngine: 'mastodon' })).toBe('mastodon');
    expect(deliveryEngine({ delivery: 'extension', extensionEngine: 'unknown' })).toBeUndefined();
    expect(deliveryEngine({ extensionEngine: 'mastodon' })).toBeUndefined();
    expect(deliveryEngine(null)).toBeUndefined();
  });

  it('explains an over-limit post in Vietnamese with both numbers', () => {
    expect(postLengthMessage('Mastodon', { length: 545, maxChars: 500, over: true, counting: 'mastodon' }))
      .toBe('Bài Mastodon dài 545/500 ký tự, vượt giới hạn của nền tảng. Rút gọn trước khi duyệt hoặc đăng.');
  });
});

describe('fitToLimit', () => {
  const mastodon = platformContract('mastodon');

  it('leaves a post that fits, or a destination without a limit, untouched', () => {
    const fitting = { title: null, body: SENTENCES[0]!, hashtags: ['vps'] };
    expect(fitToLimit(fitting, mastodon, SOURCE)).toBe(fitting);
    const long = { title: 'T', body: SENTENCES.join(' ').repeat(10), hashtags: [] };
    expect(fitToLimit(long, platformContract('nginx-community'), SOURCE)).toBe(long);
  });

  it('brings a 545-character Mastodon draft under 500 by ending after a whole sentence, keeping one hashtag', () => {
    const draft = mastodonDraft();
    expect(publishedLength(draft, mastodon, SOURCE)).toBe(545);
    const fitted = fitToLimit(draft, mastodon, SOURCE);
    expect(publishedLength(fitted, mastodon, SOURCE)).toBeLessThanOrEqual(500);
    expect(checkPostLength({ ...fitted, platformSlug: 'mastodon', canonicalUrl: SOURCE }).over).toBe(false);
    const text = fitted.body.replace(/\n\n#vps$/, '');
    expect(fitted.body).toMatch(/\n\n#vps$/);
    // The text is the first sentences, unchanged and complete.
    expect(SENTENCES.join(' ').startsWith(text)).toBe(true);
    expect(text).toMatch(/[.?]$/);
    expect(fitted.hashtags).toEqual(['vps']);
    // Rendering adds the source line and does not bring the dropped tags back.
    expect(renderPostText(fitted, mastodon, SOURCE).body).toBe(`${fitted.body}\n\nNguồn: ${SOURCE}`);
  });

  it('only drops closing hashtags when that is enough', () => {
    const body = `${'Một câu ngắn gọn về VPS. '.repeat(18).trim()}\n\n#vps #nvme #linux`;
    const draft = { title: null, body, hashtags: ['vps', 'nvme', 'linux'] };
    const limit = publishedLength({ ...draft, body: body.replace(' #linux', '') }, mastodon, SOURCE);
    const fitted = fitToLimit(draft, { ...mastodon, maxChars: limit }, SOURCE);
    expect(fitted.body).toBe(body.replace(' #linux', ''));
    expect(fitted.hashtags).toEqual(['vps', 'nvme']);
  });

  it('never removes a hashtag that is part of a sentence', () => {
    const body = `Mình dùng #docker để chạy thử. ${'Câu dài thêm nữa cho đủ độ dài. '.repeat(20).trim()} Bạn thử chạy #docker`;
    const fitted = fitToLimit({ title: null, body, hashtags: ['docker'] }, mastodon, null);
    expect(fitted.body.startsWith('Mình dùng #docker để chạy thử.')).toBe(true);
    expect(publishedLength(fitted, mastodon, null)).toBeLessThanOrEqual(500);
  });

  it('does not add the source line again when the body already links to it', () => {
    const body = `${SENTENCES[0]} Chi tiết: ${SOURCE}/ ${SENTENCES.slice(1).join(' ')}`;
    expect(renderPostText({ title: null, body, hashtags: [] }, mastodon, SOURCE).body).toBe(body);
    const fitted = fitToLimit({ title: null, body: `${body} ${SENTENCES.join(' ')}`, hashtags: [] }, mastodon, SOURCE);
    expect(fitted.body).toContain(`${SOURCE}/`);
    // The link stays in the text, so the 9 + 23 characters of the source line are free for it.
    expect(renderPostText(fitted, mastodon, SOURCE).body).toBe(fitted.body);
    expect(publishedLength(fitted, mastodon, SOURCE)).toBeLessThanOrEqual(500);
  });

  it('cuts after the last whole word with "…" when even the first sentence is too long', () => {
    const body = `${'Máy chủ ảo tốc độ cao '.repeat(40).trim()}. Câu sau.`;
    const fitted = fitToLimit({ title: null, body, hashtags: [] }, mastodon, null);
    const kept = fitted.body.slice(0, -1);
    expect(fitted.body.endsWith('…')).toBe(true);
    expect(body.startsWith(kept)).toBe(true);
    // It stops right before a space: no word is cut in half.
    expect(body[kept.length]).toBe(' ');
    expect([...fitted.body].length).toBeLessThanOrEqual(500);
    expect([...fitted.body].length).toBeGreaterThan(490);
  });

  it('keeps emoji and accents whole when the text has no spaces to cut at', () => {
    const body = '👨‍👩‍👧‍👦ệ'.repeat(400);
    const fitted = fitToLimit({ title: null, body, hashtags: [] }, mastodon, null);
    const kept = graphemes(fitted.body.slice(0, -1));
    expect(fitted.body.endsWith('…')).toBe(true);
    expect(kept.length + 1).toBe(500);
    expect(kept.every((segment, index) => segment === (index % 2 ? 'ệ' : '👨‍👩‍👧‍👦'))).toBe(true);
  });

  it('never glues "…" to a link it stops after', () => {
    const body = `Xem ${SOURCE}/a ${'tiếp '.repeat(200).trim()}`;
    const fitted = fitToLimit({ title: null, body, hashtags: [] }, { ...mastodon, maxChars: 30 }, null);
    expect(fitted.body).toBe(`Xem ${SOURCE}/a …`);
  });

  it('fits X by its weighted count, where Vietnamese letters with diacritics count twice', () => {
    const x = platformContract('x');
    const draft = { title: null, body: `${SENTENCES.join(' ')} #vps`, hashtags: ['vps'] };
    // Fewer than 280 graphemes would fit by the plain count, but not by X's.
    expect([...`${SENTENCES.slice(0, 3).join(' ')} #vps`].length).toBeLessThan(280);
    expect(publishedLength({ ...draft, body: `${SENTENCES.slice(0, 3).join(' ')} #vps` }, x, SOURCE)).toBeGreaterThan(280);
    const fitted = fitToLimit(draft, x, SOURCE);
    expect(publishedLength(fitted, x, SOURCE)).toBeLessThanOrEqual(280);
    expect(fitted.body).toBe(`${SENTENCES.slice(0, 2).join(' ')} #vps`);
  });

  it('removes Markdown before cutting a plain-text post', () => {
    const body = `**${SENTENCES[0]}** ${SENTENCES.slice(1).join(' ')}`;
    const fitted = fitToLimit({ title: null, body, hashtags: [] }, platformContract('bluesky'), null);
    expect(fitted.body).not.toContain('**');
    expect(publishedLength(fitted, platformContract('bluesky'), null)).toBeLessThanOrEqual(300);
  });

  it('drops hashtags a connector appends (Instagram) before cutting the caption', () => {
    const caption = SENTENCES[0]!;
    const instagram = { ...platformContract('instagram'), maxChars: [...`${caption}\n\n#vps #nvme`].length };
    const draft = { title: null, body: caption, hashtags: ['vps', 'nvme', 'linux', 'cloud'] };
    const fitted = fitToLimit(draft, instagram, null);
    expect(fitted).toEqual({ title: null, body: caption, hashtags: ['vps', 'nvme'] });
  });
});
