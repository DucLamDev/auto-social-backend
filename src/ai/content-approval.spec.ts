import { platformContract } from '../platforms/platform-contract';
import {
  aiRoleSetting, approvalInput, approvalInstructions, approvalJsonSchema, approvalVerdict, brandRiskAcceptable, normalizeBrandRisk, parseAiRole,
} from './content-approval';

describe('final AI approval', () => {
  const yes = { approved: true, score: 9, risk: 'none', seeding: false, reasons: [] as string[] };

  it('approves only a yes without seeding and with no or low risk', () => {
    expect(approvalVerdict(yes)).toEqual({ status: 'approved', score: 9, risk: 'none', seeding: false, reasons: [] });
    expect(approvalVerdict({ ...yes, risk: 'low', reasons: ['Câu cuối hơi dài '] })).toMatchObject({ status: 'approved', risk: 'low', reasons: ['Câu cuối hơi dài'] });
    expect(approvalVerdict({ ...yes, approved: false, reasons: ['Mở bài nhạt'] })).toMatchObject({ status: 'rejected', reasons: ['Mở bài nhạt'] });
  });

  it('overrides a yes with seeding or a medium/high risk and says why', () => {
    expect(approvalVerdict({ ...yes, seeding: true })).toMatchObject({ status: 'rejected', seeding: true, reasons: ['Bài có dấu hiệu seeding (quảng cáo trá hình)'] });
    expect(approvalVerdict({ ...yes, risk: 'High', reasons: ['Hứa uptime 100%'] }))
      .toMatchObject({ status: 'rejected', risk: 'high', reasons: ['Rủi ro cho công ty: mức cao', 'Hứa uptime 100%'] });
    // An unreadable risk from the final gate is not taken as safe.
    expect(approvalVerdict({ ...yes, risk: 'unclear' })).toMatchObject({ status: 'rejected', risk: 'medium' });
  });

  it('clamps the score and bounds the reasons', () => {
    const verdict = approvalVerdict({ ...yes, approved: false, score: 14.6, reasons: ['', ...Array.from({ length: 8 }, (_, index) => `${index}${'x'.repeat(400)}`)] });
    expect(verdict.score).toBe(10);
    expect(verdict.reasons).toHaveLength(5);
    expect(verdict.reasons!.every((reason) => reason.length <= 300)).toBe(true);
    expect(approvalVerdict({ ...yes, approved: false, score: Number.NaN })).toMatchObject({ score: 1, reasons: ['AI duyệt cuối không nêu lý do từ chối'] });
  });

  it('reads risk levels and keeps role settings round-trippable', () => {
    expect(['none', 'Low', 'moderate', 'HIGH', 'no risk', '', 'maybe', null].map(normalizeBrandRisk)).toEqual(['none', 'low', 'medium', 'high', 'none', null, null, null]);
    expect(brandRiskAcceptable('low')).toBe(true);
    expect(brandRiskAcceptable('medium')).toBe(false);
    expect(brandRiskAcceptable(undefined)).toBe(false);
    expect(aiRoleSetting(parseAiRole('vpsttt:claude:opus', 'X'))).toBe('vpsttt:claude:opus');
    expect(aiRoleSetting(parseAiRole('OpenAI', 'X'))).toBe('openai');
    expect(approvalJsonSchema.properties.risk.enum).toEqual(['none', 'low', 'medium', 'high']);
  });

  it('asks a brand-safety approver for VPSTTT to judge the post as published, with the brief, brand facts and review', () => {
    const contract = platformContract('bluesky');
    const instructions = approvalInstructions(contract);
    expect(instructions).toContain('final approver for posts published on behalf of VPSTTT, a VPS and proxy provider');
    expect(instructions).toContain('Approve only when every point holds');
    expect(instructions).toContain('No guarantee they do not back, such as cheapest, 100% uptime, unlimited');
    expect(instructions).toContain('reasons: at most 5 short reasons in Vietnamese');
    const input = approvalInput(contract, {
      rules: 'Destination contract for Bluesky (mandatory):',
      briefKind: 'short marketing brief',
      brief: 'Giới thiệu VPS NVMe',
      brandBlock: '<brand_facts>\nBrand: VPSTTT\n</brand_facts>',
      post: { title: '', body: 'Bài đăng\n\n#vps', tags: [] },
      image: { prompt: 'A server rack', altText: 'Máy chủ' },
      reviewNotes: 'Editor score 8/10',
    });
    expect(input).toContain('<destination_rules>\nDestination contract for Bluesky (mandatory):\n</destination_rules>');
    expect(input).toContain('Brief or source (short marketing brief):\nGiới thiệu VPS NVMe');
    expect(input).toContain('<brand_facts>');
    expect(input).toContain('<post>\n<body>\nBài đăng\n\n#vps\n</body>\n</post>');
    expect(input).toContain('- Generator prompt: A server rack\n- Alt text: Máy chủ');
    expect(input).toContain("The editor's last review:\nEditor score 8/10");
    expect(approvalInput(contract, { rules: '', briefKind: 'source content', brief: 'x', brandBlock: '', post: { title: 'T', body: 'B', tags: ['nginx'] } }))
      .toContain('<title>T</title>\n<body>\nB\n</body>\n<tags>nginx</tags>');
  });
});
