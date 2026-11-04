import { platformContract } from '../platforms/platform-contract';
import { clampReview, deterministicIssues, draftRank, qualityInstructions, reviewPassed, rewriteFeedback } from './content-quality';

const VI = 'Mình vừa chuyển website sang máy chủ mới và thời gian tải trang giảm hẳn, chia sẻ lại các bước đã làm.';
const EN = 'We moved our website to a new server and page load time dropped a lot, here are the steps we followed.';
const review = { score: 8, hook: 8, specificity: 8, platformFit: 8, naturalness: 8, languageOk: true, unsupportedClaims: [], issues: [] };

describe('content quality checks', () => {
  it('accepts a draft that fits its destination', () => {
    expect(deterministicIssues({ title: 'Moving to a faster server', body: EN, hashtags: ['nginx'] }, platformContract('nginx-community'))).toEqual([]);
  });

  it('flags length, missing title, wrong language, Markdown in HTML, hashtag overload and cliches', () => {
    const bluesky = platformContract('bluesky', { sourceText: VI });
    expect(deterministicIssues({ title: null, body: `${VI} ${'x'.repeat(250)}`, hashtags: [] }, bluesky)[0]).toMatch(/^Dài \d+\/300 ký tự/);
    expect(deterministicIssues({ title: null, body: EN, hashtags: [] }, platformContract('nginx-community'))).toContain('Thiếu tiêu đề');
    expect(deterministicIssues({ title: 'Title', body: VI, hashtags: [] }, platformContract('nginx-community'))).toContain('Sai ngôn ngữ: cần viết tiếng Anh');
    expect(deterministicIssues({ title: 'Tiêu đề', body: `## Mục\n${VI}`, hashtags: [] }, platformContract('wordpress', { sourceText: VI })))
      .toContain('Còn ký hiệu Markdown trong khi nơi đăng cần HTML');
    expect(deterministicIssues({ title: null, body: `${VI} #a #b #c`, hashtags: [] }, bluesky)).toContain('Quá nhiều hashtag (3), tối đa 2');
    expect(deterministicIssues({ title: null, body: `Hãy cùng khám phá: ${VI}`, hashtags: [] }, bluesky)).toContain('Có câu sáo: "hãy cùng khám phá"');
    expect(deterministicIssues({ title: null, body: ' ', hashtags: [] }, bluesky)).toEqual(['Nội dung trống']);
  });

  it('passes only reviews with a high score, the right language and no unsupported claims', () => {
    expect(reviewPassed(review)).toBe(true);
    expect(reviewPassed({ ...review, score: 6 })).toBe(false);
    expect(reviewPassed({ ...review, languageOk: false })).toBe(false);
    expect(reviewPassed({ ...review, unsupportedClaims: ['Uptime 100%'] })).toBe(false);
  });

  it('clamps scores and trims lists from the reviewer', () => {
    expect(clampReview({ ...review, score: 14, hook: 0.2, issues: [' a ', '', 'b', 'c', 'd', 'e', 'f'] }))
      .toMatchObject({ score: 10, hook: 1, issues: ['a', 'b', 'c', 'd', 'e'] });
  });

  it('builds de-duplicated rewrite feedback, ending with the sub-scores of a failing review', () => {
    expect(rewriteFeedback(['Thiếu tiêu đề', 'Thiếu tiêu đề'], { ...review, unsupportedClaims: ['Giá rẻ nhất'], issues: ['Mở bài chung chung'] }))
      .toBe(`- Thiếu tiêu đề\n- Remove or ground this claim: Giá rẻ nhất\n- Mở bài chung chung\n- Editor scores (1-10): overall ${review.score}, hook ${review.hook}, specificity ${review.specificity}, platform fit ${review.platformFit}, naturalness ${review.naturalness}. Raise the lowest first.`);
    expect(rewriteFeedback(['Thiếu tiêu đề'], review)).toBe('- Thiếu tiêu đề');
  });

  it('gives the writer the editor rubric, with the Stack Exchange question rules only there', () => {
    const contract = platformContract('unix-linux-stackexchange');
    const rules = qualityInstructions(contract, 'stackexchange');
    expect(rules).toContain('aim for 9');
    expect(rules).toContain('Hook: the first line');
    expect(rules).toContain('"game-changer"');
    expect(rules).toContain('Stack Exchange: one precise, answerable technical question');
    expect(qualityInstructions(platformContract('bluesky'))).not.toContain('Stack Exchange');
  });

  it('ranks a passing draft first, then the higher score, then fewer machine issues', () => {
    expect(draftRank(true, { ...review, score: 7 }, [])).toBeGreaterThan(draftRank(false, { ...review, score: 9 }, []));
    expect(draftRank(false, { ...review, score: 6 }, ['a'])).toBeGreaterThan(draftRank(false, { ...review, score: 5 }, []));
    expect(draftRank(false, { ...review, score: 6 }, [])).toBeGreaterThan(draftRank(false, { ...review, score: 6 }, ['a']));
    expect(draftRank(false, null, [])).toBeLessThan(draftRank(false, { ...review, score: 1 }, []));
  });
});
