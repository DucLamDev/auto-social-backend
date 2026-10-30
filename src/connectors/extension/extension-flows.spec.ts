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
});
