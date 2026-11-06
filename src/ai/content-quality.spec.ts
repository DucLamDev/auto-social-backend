import { platformContract } from '../platforms/platform-contract';
import { approvalInstructions } from './content-approval';
import {
  clampReview, ContentReview, deterministicIssues, draftRank, missingSafetyFields, qualityInstructions, reviewInstructions, reviewJsonSchema,
  reviewPassed, ReviewSchema, reviewSummary, reviewVerdict, rewriteFeedback, safetyProblems, scoreFromReason,
} from './content-quality';

const VI = 'Mình vừa chuyển website sang máy chủ mới và thời gian tải trang giảm hẳn, chia sẻ lại các bước đã làm.';
const EN = 'We moved our website to a new server and page load time dropped a lot, here are the steps we followed.';
const review: ContentReview = {
  score: 8, hook: 8, specificity: 8, platformFit: 8, naturalness: 8, languageOk: true, unsupportedClaims: [], issues: [],
  seeding: { detected: false, notes: [] }, brandRisk: 'none', riskNotes: [],
};

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

  it('ranks every draft that fits the limit above every draft over it', () => {
    expect(draftRank(false, { ...review, score: 1 }, ['a', 'b', 'c'])).toBeGreaterThan(draftRank(false, { ...review, score: 10 }, ['Dài 545/500 ký tự'], true));
    expect(draftRank(false, null, [])).toBeGreaterThan(draftRank(false, { ...review, score: 10 }, [], true));
    expect(draftRank(false, { ...review, score: 8 }, ['x'], true)).toBeGreaterThan(draftRank(false, { ...review, score: 6 }, ['x'], true));
  });

  it('says how many characters to cut', () => {
    const mastodon = platformContract('mastodon', { sourceText: VI });
    const body = `${VI} ${'a'.repeat(400)}`;
    const issues = deterministicIssues({ title: null, body, hashtags: [] }, mastodon, 'https://vpsttt.vn/x');
    // The text, a blank line, "Nguồn: " and the link counted as 23.
    const length = [...body].length + 2 + 7 + 23;
    expect(issues[0]).toBe(`Dài ${length}/500 ký tự, cần bớt ít nhất ${length - 500} ký tự`);
  });

  it('tells the editor the limit, the draft length and the room left, and nothing about length where there is none', () => {
    const bluesky = platformContract('bluesky');
    expect(reviewInstructions(bluesky, 280)).toContain('the published post has at most 300 characters, counting hashtags, links and the source line the system adds; this draft has 280. Judge it within that limit and never ask for additions that would not fit; only 20 characters are left, so any fix that adds text must stay within them or say what to cut to make room.');
    expect(reviewInstructions(bluesky, 320)).toContain('it is 20 characters over, so one issue must ask to cut at least 20 characters');
    expect(reviewInstructions(platformContract('nginx-community'))).not.toContain('length limit');
  });

  it('anchors the scores and keeps facts from the brief out of the unsupported claims', () => {
    const text = reviewInstructions(platformContract('bluesky'), 280);
    expect(text).toContain('8 ready to publish, only optional polish left; 7 ready to publish with one clear weakness');
    expect(text).toContain('Whatever the brief or the brand facts state, even in a few words, is supported');
    expect(text).toContain('Never list a statement you consider supported or partly supported.');
    expect(text).toContain('Fixes must not contradict each other. Leave it empty for a score of 9 or 10.');
  });

  it('judges a revision against its old score and the fixes the operator asked for', () => {
    const bluesky = platformContract('bluesky');
    expect(reviewInstructions(bluesky, 280)).not.toContain('revises an earlier version');
    expect(reviewInstructions(bluesky, 280, null)).not.toContain('revises an earlier version');
    const revised = reviewInstructions(bluesky, 280, { score: 7, fixes: ['Câu cuối hơi quảng cáo', ' ', 'Thêm lệnh kiểm tra'] });
    expect(revised).toContain('This draft revises an earlier version that you scored 7/10. The operator asked the writer to fix:\n- Câu cuối hơi quảng cáo\n- Thêm lệnh kiểm tra\nCheck those fixes first.');
    expect(revised).toContain('the score must be higher than 7. Never ask to undo a requested fix or for its opposite');
    // A draft that was never scored is still judged by its fixes.
    expect(reviewInstructions(bluesky, 280, { score: null, fixes: ['Thêm ví dụ'] })).toContain('the score must be raised accordingly');
    // Bounded: the operator may choose up to 20 long points.
    const many = reviewInstructions(bluesky, 280, { score: 6, fixes: Array.from({ length: 20 }, (_, index) => `${index}:${'x'.repeat(1_000)}`) });
    expect(many).toContain(`- 9:${'x'.repeat(398)}\n`);
    expect(many).not.toContain('- 10:');
    expect(many).not.toContain('x'.repeat(399));
  });

  it('fails clumsy seeding and a medium or high company risk whatever the score', () => {
    expect(reviewPassed({ ...review, score: 9, seeding: { detected: true, notes: ['Giả làm khách hàng'] } })).toBe(false);
    expect(reviewPassed({ ...review, score: 9, brandRisk: 'medium' })).toBe(false);
    expect(reviewPassed({ ...review, score: 9, brandRisk: 'high' })).toBe(false);
    expect(reviewPassed({ ...review, score: 9, brandRisk: 'low', riskNotes: ['Chữ "nhanh nhất" hơi quá'] })).toBe(true);
  });

  it('sends seeding and company-risk notes to the writer first and into the stored problems', () => {
    const flagged: ContentReview = {
      ...review, score: 9, issues: ['Mở bài chung chung'],
      seeding: { detected: true, notes: ['Câu "mình là khách quen" giả làm người dùng độc lập'] },
      brandRisk: 'high', riskNotes: ['Hướng dẫn dùng proxy để lách lệnh cấm tài khoản'],
    };
    const feedback = rewriteFeedback([], flagged).split('\n');
    expect(feedback.slice(0, 2)).toEqual([
      '- Clumsy seeding (reads as a disguised advert), fix it: Câu "mình là khách quen" giả làm người dùng độc lập',
      '- Risk for the company (high), remove it: Hướng dẫn dùng proxy để lách lệnh cấm tài khoản',
    ]);
    expect(feedback).toContain('- Mở bài chung chung');
    expect(safetyProblems(flagged)).toEqual([
      'Seeding: Câu "mình là khách quen" giả làm người dùng độc lập',
      'Rủi ro cho công ty: Hướng dẫn dùng proxy để lách lệnh cấm tài khoản',
    ]);
    // Without notes the problem is still named.
    expect(safetyProblems({ ...review, seeding: { detected: true, notes: [] }, brandRisk: 'medium' }))
      .toEqual(['Seeding: bài đọc như quảng cáo trá hình', 'Rủi ro cho công ty: mức trung bình']);
    expect(safetyProblems({ ...review, brandRisk: 'low', riskNotes: ['nhỏ'] })).toEqual([]);
    expect(safetyProblems(null)).toEqual([]);
  });

  it('takes a review without the seeding and risk fields as not detected, and reports them missing', () => {
    const old = ReviewSchema.parse({ score: 8, hook: 8, specificity: 8, platformFit: 8, naturalness: 8, languageOk: true, unsupportedClaims: [], issues: [] });
    expect(missingSafetyFields(old)).toEqual(['seeding', 'brandRisk']);
    expect(clampReview(old)).toMatchObject({ seeding: { detected: false, notes: [] }, brandRisk: 'none', riskNotes: [] });
    expect(reviewPassed(clampReview(old))).toBe(true);
    const loose = ReviewSchema.parse({ ...old, seeding: { detected: true }, brandRisk: 'Moderate', riskNotes: [' a ', '', 'b', 'c', 'd'] });
    expect(missingSafetyFields(loose)).toEqual([]);
    expect(clampReview(loose)).toMatchObject({ seeding: { detected: true, notes: [] }, brandRisk: 'medium', riskNotes: ['a', 'b', 'c'] });
    expect(reviewJsonSchema.required).toEqual(expect.arrayContaining(['seeding', 'brandRisk', 'riskNotes']));
  });

  it('defines seeding and company risk for the editor', () => {
    const text = reviewInstructions(platformContract('bluesky'), 280);
    expect(text).toContain('pretends to be an unaffiliated customer or a neutral user');
    expect(text).toContain('fake or invented testimonials');
    expect(text).toContain('disparages competitors');
    expect(text).toContain('without saying the author is affiliated');
    expect(text).toContain('VPSTTT, a VPS and proxy provider');
    expect(text).toContain('cheapest, 100% uptime, unlimited');
    expect(text).toContain('evading bans or blocks, scraping against terms of service, spam');
    expect(text).toContain('embarrass the company if a reader took a screenshot');
    expect(text).toContain('A draft with seeding detected or a medium or high brandRisk fails whatever its score');
  });

  it('summarises the review for the final approver', () => {
    expect(reviewSummary({ ...review, brandRisk: 'low', riskNotes: ['nhỏ'] }, [])).toContain('Editor score 8/10');
    expect(reviewSummary({ ...review, brandRisk: 'low', riskNotes: ['nhỏ'] }, [])).toContain('Brand risk: low (nhỏ).');
    expect(reviewSummary(null, ['Thiếu tiêu đề'])).toBe('The editor could not score this draft (reviewer unavailable). Machine checks still failing: Thiếu tiêu đề.');
  });

  it('reads the stored score from a reason', () => {
    expect(scoreFromReason('Cần xem lại (AI chấm 7/10): Câu cuối hơi cụt')).toBe(7);
    expect(scoreFromReason('Hợp người đọc (AI chấm 10/10) · đã rút gọn tự động để vừa 500 ký tự')).toBe(10);
    expect(scoreFromReason('Cần xem lại (AI chưa chấm được): Dài 520/500 ký tự')).toBeNull();
    expect(scoreFromReason(null)).toBeNull();
  });

  it('turns Opus\'s last review into the final verdict, refusing on seeding, risk, a low score or open machine issues', () => {
    expect(reviewVerdict({ ...review, issues: ['a', 'b', 'c'] })).toEqual({ status: 'approved', score: 8, risk: 'none', seeding: false, reasons: ['a', 'b'] });
    expect(reviewVerdict(review, ['Dài 320/300 ký tự'])).toMatchObject({ status: 'rejected', reasons: ['Dài 320/300 ký tự'] });
    expect(reviewVerdict({ ...review, seeding: { detected: true, notes: ['Giả làm khách hàng'] }, brandRisk: 'medium', riskNotes: ['Hứa không bị chặn'] }))
      .toEqual({ status: 'rejected', score: 8, risk: 'medium', seeding: true, reasons: ['Seeding: Giả làm khách hàng', 'Rủi ro cho công ty: Hứa không bị chặn'] });
    expect(reviewVerdict({ ...review, score: 5, languageOk: false, unsupportedClaims: ['Hỗ trợ IPv6'] }).reasons)
      .toEqual(['Thông tin chưa có căn cứ: Hỗ trợ IPv6', 'Bài viết sai ngôn ngữ của nơi đăng', 'Điểm 5/10, dưới mức đạt 7/10']);
  });

  it('tells the writer the brief is not text for the reader, and the editor to catch leaked internal text', () => {
    const writer = qualityInstructions(platformContract('server-fault'));
    expect(writer).toContain('never quote, copy or paraphrase them into the post');
    expect(writer).toContain('do not mention it at all, not even to say it is unconfirmed');
    expect(writer).toContain('Never put notes to the operator in the post');
    expect(reviewInstructions(platformContract('bluesky'))).toContain('Leaked internal text');
  });

  it('asks for a disclosure only inside a product mention on forums, never on the brand\'s own social account', () => {
    const forum = platformContract('server-fault');
    const social = platformContract('bluesky', { sourceText: VI });
    // No fixed example sentence: drafts copied it word for word.
    expect(qualityInstructions(forum)).toContain('only when the post names or recommends the brand or its product, say that you work there inside that same sentence');
    expect(qualityInstructions(forum)).not.toMatch(/I work at VPSTTT|Mình làm ở VPSTTT|Layout/);
    expect(qualityInstructions(social)).toContain('posts go out from the brand\'s own account');
    expect(qualityInstructions(social)).toContain('one hook line; then the body as one short paragraph or 2 to 4 short bullets');
    expect(reviewInstructions(social)).toContain('any other disclosure is unnecessary and reads oddly');
    expect(reviewInstructions(forum)).toContain('glued to an unrelated tip or caveat');
    expect(approvalInstructions(social)).toContain('Refuse a post with an "I work at …" or "Mình làm ở …" sentence');
  });
});
