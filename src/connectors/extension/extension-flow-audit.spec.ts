import { AI_COMMUNITY_NOTE, extensionFlowAudit } from './extension-flow-audit';

describe('posting flow status shown after a login check', () => {
  it('says Warrior Forum is manual only because its terms forbid automated access', () => {
    expect(extensionFlowAudit('warrior-forum', {})).toMatchObject({ status: 'MANUAL_ONLY', implemented: false, url: 'https://www.warriorforum.com/tos.html' });
    expect(extensionFlowAudit('warrior-forum', {}).message).toMatch(/cấm bot/);
  });

  it('keeps the other gaps as they were', () => {
    expect(extensionFlowAudit('dailymotion', {})).toMatchObject({ status: 'FLOW_REQUIRED', implemented: false });
    expect(extensionFlowAudit('voz-forums', {})).toMatchObject({ status: 'DESTINATION_REQUIRED', implemented: true, engine: 'xenforo' });
  });

  it('lists Disqus and MeWe as ready to configure now that they have posting flows, each with a default page', () => {
    expect(extensionFlowAudit('disqus', {})).toMatchObject({ status: 'CONFIGURATION_REQUIRED', implemented: true, engine: 'disqus' });
    expect(extensionFlowAudit('mewe', {})).toMatchObject({ status: 'CONFIGURATION_REQUIRED', implemented: true, engine: 'mewe' });
    expect(extensionFlowAudit('disqus', { delivery: 'extension', extensionEngine: 'disqus', extensionTargetUrl: 'https://disqus.com/home/discuss/channel-discussdisqus/', extensionAutoSubmit: true }))
      .toMatchObject({ status: 'CONFIGURED', engine: 'disqus' });
    expect(extensionFlowAudit('mewe', { delivery: 'extension', extensionEngine: 'mewe', extensionTargetUrl: 'https://mewe.com/myworld', extensionAutoSubmit: true }))
      .toMatchObject({ status: 'CONFIGURED', engine: 'mewe' });
  });

  it('no longer asks Stack Exchange accounts for configured tags: the AI tags of each post fill the tag field', () => {
    const settings = { delivery: 'extension', extensionEngine: 'stackexchange', extensionTargetUrl: 'https://unix.stackexchange.com/questions/ask', extensionAutoSubmit: true };
    expect(extensionFlowAudit('unix-linux-stackexchange', settings)).toMatchObject({ status: 'CONFIGURED', implemented: true, engine: 'stackexchange' });
    expect(extensionFlowAudit('unix-linux-stackexchange', { ...settings, extensionTags: [] })).toMatchObject({ status: 'CONFIGURED' });
  });

  it('lists Product Hunt forums as ready to configure now that threads have a posting flow', () => {
    expect(extensionFlowAudit('product-hunt', {})).toMatchObject({ status: 'CONFIGURATION_REQUIRED', implemented: true, engine: 'producthunt' });
    expect(extensionFlowAudit('product-hunt', { delivery: 'extension', extensionEngine: 'producthunt', extensionTargetUrl: 'https://www.producthunt.com/p/new', extensionAutoSubmit: true }))
      .toMatchObject({ status: 'CONFIGURED', implemented: true, engine: 'producthunt' });
  });

  it('lists daily.dev as ready to configure now that it has a posting flow', () => {
    expect(extensionFlowAudit('daily-dev', {})).toMatchObject({ status: 'CONFIGURATION_REQUIRED', implemented: true, engine: 'dailydev' });
    expect(extensionFlowAudit('daily-dev', { delivery: 'extension', extensionEngine: 'dailydev', extensionTargetUrl: 'https://daily.dev/squads/create', extensionAutoSubmit: true }))
      .toMatchObject({ status: 'CONFIGURED', implemented: true, engine: 'dailydev' });
  });

  it('asks for a Lemmy / Discuit community only while AI form filling is off', () => {
    const lemmy = { delivery: 'extension', extensionEngine: 'lemmy', extensionTargetUrl: 'https://lemmy.world/create_post', extensionAutoSubmit: true };
    expect(extensionFlowAudit('lemmy-world', lemmy)).toMatchObject({ status: 'DESTINATION_REQUIRED', engine: 'lemmy' });
    expect(extensionFlowAudit('lemmy-world', lemmy).message).toContain('community đích');
    const withAi = extensionFlowAudit('lemmy-world', lemmy, { formFill: true });
    expect(withAi).toMatchObject({ status: 'CONFIGURED', implemented: true, engine: 'lemmy' });
    expect(withAi.message).toContain(AI_COMMUNITY_NOTE);
    const discuit = { delivery: 'extension', extensionEngine: 'discuit', extensionTargetUrl: 'https://discuit.org/new', extensionAutoSubmit: true };
    expect(extensionFlowAudit('discuit', discuit, { formFill: true })).toMatchObject({ status: 'CONFIGURED', engine: 'discuit' });
    // A configured community needs no note.
    expect(extensionFlowAudit('lemmy-world', { ...lemmy, extensionCategory: 'selfhosted' }, { formFill: true }).message).not.toContain(AI_COMMUNITY_NOTE);
    // Other gaps still block.
    expect(extensionFlowAudit('lemmy-world', {}, { formFill: true })).toMatchObject({ status: 'CONFIGURATION_REQUIRED' });
  });
});
