import { reviewDestination } from './review-destination';

describe('provider review destinations', () => {
  it.each([
    ['https://caddy.community/new-topic?title=secret#composer', 'https://caddy.community/my/activity/pending'],
    ['https://www.mongodb.com/community/forums/categories', 'https://www.mongodb.com/community/forums/my/activity/pending'],
    ['https://forum.example/community/c/help/23', 'https://forum.example/community/my/activity/pending'],
    ['https://forum.example/community/', 'https://forum.example/community/my/activity/pending'],
    ['https://forum.example/my/activity/pending', 'https://forum.example/my/activity/pending'],
  ])('preserves the installation path and removes input data from %s', (extensionTargetUrl, expected) => {
    expect(reviewDestination({ extensionEngine: 'discourse', extensionTargetUrl })).toEqual({ reviewUrl: expected, reviewUrlKind: 'pending_queue' });
  });
  it.each(['javascript:alert(1)', 'https://user:password@forum.example/', 'http://forum.example/', 'invalid'])('omits unsafe destination %s', baseUrl => {
    expect(reviewDestination({ extensionEngine: 'discourse', baseUrl })).toEqual({});
  });
  it('does not invent a Discourse queue on other platforms', () => {
    expect(reviewDestination({ extensionEngine: 'quora', baseUrl: 'https://www.quora.com/' })).toEqual({ reviewUrl: 'https://www.quora.com/', reviewUrlKind: 'platform' });
  });
});
