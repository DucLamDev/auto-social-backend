import { EXTENSION_FLOWS, extensionFlowDefaults, validateExtensionFlow } from './extension-flows';

describe('per-platform Chrome flows', () => {
  it.each(EXTENSION_FLOWS)('binds $name to its own engine and forum', (flow) => {
    const targetUrl = flow.targetUrl || ({ substack: 'https://example.substack.com/publish/post', quora: 'https://example.quora.com/', reddit: 'https://www.reddit.com/r/example/submit', tinhte: 'https://tinhte.vn/editorv2/create/293/' } as Record<string, string>)[flow.id] || `${flow.forumUrl}/forums/example.1/post-thread`;
    expect(validateExtensionFlow(flow.id, { engine: flow.engine, targetUrl, autoSubmit: true })).toBe(flow);
    expect(extensionFlowDefaults(flow.id)).toMatchObject({ extensionFlowId: flow.id, extensionEngine: flow.engine });
    expect(() => validateExtensionFlow(flow.id, { engine: flow.engine, targetUrl: 'https://wrong-forum.example/new-topic', autoSubmit: true })).toThrow();
  });

  it('keeps MongoDB inside the forum subpath and retains custom self-hosted support', () => {
    expect(() => validateExtensionFlow('mongodb-community', { engine: 'discourse', targetUrl: 'https://www.mongodb.com/new-topic', autoSubmit: true })).toThrow('requires');
    expect(validateExtensionFlow('discourse', { engine: 'discourse', targetUrl: 'https://custom.example/forum/new-topic', autoSubmit: true })).toBeUndefined();
    expect(extensionFlowDefaults('instagram')).toEqual({});
  });

  it('binds publication and Space settings without accepting lookalike or unrelated hosts', () => {
    for (const targetUrl of ['https://example.substack.com.evil.test/publish/post', 'https://substack.com/publish/post', 'https://example.substack.com/p/old-post']) {
      expect(() => validateExtensionFlow('substack', { engine: 'substack', targetUrl, autoSubmit: true })).toThrow();
    }
    for (const targetUrl of ['https://www.quora.com/', 'https://example.quora.com/']) {
      expect(validateExtensionFlow('quora', { engine: 'quora', targetUrl, autoSubmit: true })?.id).toBe('quora');
    }
    for (const targetUrl of ['https://www.quora.com/profile/someone', 'https://www.quora.com/Some-question', 'https://example.quora.com.evil.test/', 'https://www.quora.com/?redirect=other', 'https://user:pass@www.quora.com/']) {
      expect(() => validateExtensionFlow('quora', { engine: 'quora', targetUrl, autoSubmit: true })).toThrow();
    }
    expect(() => validateExtensionFlow('reddit', { engine: 'reddit', targetUrl: 'https://www.reddit.com/submit', autoSubmit: true })).toThrow('specific');
    expect(() => validateExtensionFlow('discourse', { engine: 'medium', targetUrl: 'https://example.com', autoSubmit: true })).toThrow('matching platform');
  });

  it('keeps Disqus on a channel discussion page and MeWe on the own feed', () => {
    expect(validateExtensionFlow('disqus', { engine: 'disqus', targetUrl: 'https://disqus.com/home/discuss/channel-discussdisqus/', autoSubmit: true })?.id).toBe('disqus');
    expect(validateExtensionFlow('mewe', { engine: 'mewe', targetUrl: 'https://mewe.com/myworld', autoSubmit: true })?.id).toBe('mewe');
    for (const targetUrl of ['https://disqus.com/home/', 'https://disqus.com/home/discussion/channel-discussdisqus/abc/', 'https://disqus.com/home/discuss/channel-discussdisqus/?x=1', 'https://example.com/home/discuss/channel-discussdisqus/']) {
      expect(() => validateExtensionFlow('disqus', { engine: 'disqus', targetUrl, autoSubmit: true })).toThrow();
    }
    for (const targetUrl of ['https://mewe.com/group/123', 'https://mewe.com/', 'https://example.com/myworld']) {
      expect(() => validateExtensionFlow('mewe', { engine: 'mewe', targetUrl, autoSubmit: true })).toThrow();
    }
  });

  it('keeps daily.dev on its own-profile composer page', () => {
    expect(validateExtensionFlow('daily-dev', { engine: 'dailydev', targetUrl: 'https://daily.dev/squads/create', autoSubmit: true })?.id).toBe('daily-dev');
    // A Squad the account cannot post in would silently become a profile post.
    for (const targetUrl of ['https://daily.dev/squads/vpsttt', 'https://app.daily.dev/squads/create', 'https://daily.dev/squads/create?sid=vpsttt-team',
      'https://daily.dev/squads/create?title=Hi', 'https://daily.dev/squads/create#top']) {
      expect(() => validateExtensionFlow('daily-dev', { engine: 'dailydev', targetUrl, autoSubmit: true })).toThrow();
    }
  });
});
