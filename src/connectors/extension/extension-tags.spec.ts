import { destinationTags, takesSuggestedTags } from './extension-tags';

describe('AI tags for extension tag fields', () => {
  it('turns AI tags into Stack Exchange tags after the configured ones, at most 5 in total', () => {
    expect(destinationTags('stackexchange', ['#curl', 'Reverse Proxy', 'node.js', 'c++', 'NGINX', 'dns', 'tls'], ['nginx', 'linux']))
      .toEqual(['curl', 'reverse-proxy', 'node.js']);
    expect(destinationTags('stackexchange', ['bảo mật', '--', '#'])).toEqual(['bao-mat']);
  });

  it('keeps DEV tags to lowercase letters and digits, at most 4', () => {
    expect(destinationTags('devto', ['Self-Hosting', 'web dev', '#VPS', 'devops', 'linux'])).toEqual(['selfhosting', 'webdev', 'vps', 'devops']);
  });

  it('keeps Unicode Discourse tags and drops duplicates of the configured ones', () => {
    expect(destinationTags('discourse', ['Máy chủ', 'web_server', 'Docker'], ['docker'])).toEqual(['máy-chủ', 'web-server']);
  });

  it('sends nothing to destinations without a tag field', () => {
    for (const engine of ['reddit', 'linkedin', 'bluesky', 'xenforo', 'medium'] as const) {
      expect(takesSuggestedTags(engine)).toBe(false);
      expect(destinationTags(engine, ['vps', 'linux'])).toEqual([]);
    }
  });
});
