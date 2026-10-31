import { ApiImportRow, ImportPlatform, mapApiImportRow, parseApiAccountUpload, resolveImportPlatform } from './api-account-import';

const IMPORT_PLATFORMS: ImportPlatform[] = [
  { id: 'p-devto', slug: 'devto', name: 'dev.to', connectorKey: 'devto', defaultSettings: { publishImmediately: false } },
  { id: 'p-mastodon-social', slug: 'mastodon-social', name: 'Mastodon.social', connectorKey: 'mastodon', defaultSettings: { instanceUrl: 'https://mastodon.social', visibility: 'public' } },
  { id: 'p-mastodon', slug: 'mastodon', name: 'Mastodon', connectorKey: 'mastodon', defaultSettings: {} },
  { id: 'p-bluesky', slug: 'bluesky', name: 'Bluesky', connectorKey: 'bluesky', defaultSettings: {} },
  { id: 'p-discord', slug: 'discord', name: 'Discord', connectorKey: 'discord', defaultSettings: {} },
  { id: 'p-nginx', slug: 'nginx-community', name: 'NGINX Community', connectorKey: 'discourse', defaultSettings: { baseUrl: 'https://community.nginx.org' } },
  { id: 'p-wordpress', slug: 'wordpress', name: 'WordPress', connectorKey: 'wordpress', defaultSettings: { publishStatus: 'draft' } },
  { id: 'p-instagram', slug: 'instagram', name: 'Instagram', connectorKey: 'instagram', defaultSettings: {} },
  { id: 'p-x', slug: 'x', name: 'X (Twitter)', connectorKey: 'x', defaultSettings: {} },
  { id: 'p-medium', slug: 'medium', name: 'Medium', connectorKey: 'manual', defaultSettings: {} },
  { id: 'p-vivaldi', slug: 'vivaldi-social', name: 'social.vivaldi.net', connectorKey: 'mastodon', defaultSettings: { instanceUrl: 'https://social.vivaldi.net' } },
];

function importRow(values: Partial<ApiImportRow>): ApiImportRow {
  return { source: 'upload:2', platform: '', name: '', url: '', username: '', secret: '', categoryId: '', tags: '', publishNow: '', visibility: '', ...values };
}

const platform = (slug: string) => IMPORT_PLATFORMS.find((item) => item.slug === slug)!;

describe('API account import mapping', () => {
  it('recognises platforms by slug or name regardless of case, accents and punctuation', () => {
    expect(resolveImportPlatform('dev.to', IMPORT_PLATFORMS)?.slug).toBe('devto');
    expect(resolveImportPlatform('DEVTO', IMPORT_PLATFORMS)?.slug).toBe('devto');
    expect(resolveImportPlatform('Mastodon.social', IMPORT_PLATFORMS)?.slug).toBe('mastodon-social');
    expect(resolveImportPlatform('social.vivaldi.net', IMPORT_PLATFORMS)?.slug).toBe('vivaldi-social');
    expect(resolveImportPlatform('nginx-community', IMPORT_PLATFORMS)?.slug).toBe('nginx-community');
    expect(resolveImportPlatform('Facebook', IMPORT_PLATFORMS)).toBeUndefined();
    expect(resolveImportPlatform('  ', IMPORT_PLATFORMS)).toBeUndefined();
  });

  it('maps each supported connector to the credential and setting keys it reads', () => {
    expect(mapApiImportRow(importRow({ username: '@Alice', secret: 'dev-key', publishNow: 'có' }), platform('devto'))).toEqual({
      kind: 'ready', identity: 'devto:alice', matchUsername: 'alice', username: 'Alice', name: 'dev.to · Alice',
      credential: { apiKey: 'dev-key' }, settings: { baseUrl: 'https://dev.to/api', publishImmediately: true },
    });
    expect(mapApiImportRow(importRow({ username: 'bob', secret: 'tok', visibility: 'Unlisted' }), platform('mastodon-social'))).toMatchObject({
      identity: 'mastodon:mastodon.social:bob', matchUsername: 'bob',
      credential: { instanceUrl: 'https://mastodon.social', accessToken: 'tok' }, settings: { visibility: 'unlisted' },
    });
    expect(mapApiImportRow(importRow({ username: 'carol', secret: 'tok', url: 'https://fosstodon.org/' }), platform('mastodon'))).toMatchObject({
      identity: 'mastodon:fosstodon.org:carol', credential: { instanceUrl: 'https://fosstodon.org' }, settings: { visibility: 'public' },
    });
    expect(mapApiImportRow(importRow({ username: 'dan.bsky.social', secret: 'abcd-efgh-ijkl-mnop' }), platform('bluesky'))).toMatchObject({
      credential: { identifier: 'dan.bsky.social', appPassword: 'abcd-efgh-ijkl-mnop', serviceUrl: 'https://bsky.social' },
    });
    expect(mapApiImportRow(importRow({ secret: 'https://discord.com/api/webhooks/123456/tok_en-1', username: 'Bot' }), platform('discord'))).toMatchObject({
      identity: 'discord:123456', credential: { webhookUrl: 'https://discord.com/api/webhooks/123456/tok_en-1' }, settings: { webhookUsername: 'Bot' },
    });
    expect(mapApiImportRow(importRow({ username: 'publisher-bot', secret: 'k', categoryId: '12', tags: 'web-server, nginx ,' }), platform('nginx-community'))).toMatchObject({
      identity: 'discourse:https://community.nginx.org:publisher-bot', credential: { apiKey: 'k' },
      settings: { baseUrl: 'https://community.nginx.org', apiUsername: 'publisher-bot', categoryId: 12, defaultTags: 'web-server, nginx' },
    });
    expect(mapApiImportRow(importRow({ url: 'https://blog.example.com/', username: 'editor', secret: 'app pass', publishNow: 'không' }), platform('wordpress'))).toMatchObject({
      credential: { siteUrl: 'https://blog.example.com', username: 'editor', applicationPassword: 'app pass' }, settings: { publishStatus: 'draft' },
    });
  });

  it('sends OAuth platforms to the Connect button and refuses unsupported ones', () => {
    expect(mapApiImportRow(importRow({ secret: 'x' }), platform('instagram'))).toMatchObject({ kind: 'skip', status: 'OAUTH_REQUIRED' });
    expect(mapApiImportRow(importRow({ secret: 'x' }), platform('x'))).toMatchObject({ kind: 'skip', status: 'NOT_SUPPORTED' });
    expect(mapApiImportRow(importRow({ secret: 'x' }), platform('medium'))).toMatchObject({ kind: 'skip', status: 'NOT_SUPPORTED' });
  });

  it.each([
    ['a missing secret', 'devto', { username: 'a' }, 'Thiếu Khoá bí mật'],
    ['a missing dev.to username', 'devto', { secret: 'k' }, 'Username dev.to'],
    ['an HTTP instance', 'mastodon', { username: 'a', secret: 'k', url: 'http://fosstodon.org' }, 'HTTPS'],
    ['another instance on a fixed-instance platform', 'mastodon-social', { username: 'a', secret: 'k', url: 'https://fosstodon.org' }, 'nền tảng là Mastodon'],
    ['an unknown visibility', 'mastodon-social', { username: 'a', secret: 'k', visibility: 'friends' }, 'Chế độ hiển thị'],
    ['a Bluesky login password', 'bluesky', { username: 'a.bsky.social', secret: 'hunter2' }, 'App Password'],
    ['a non-Discord webhook', 'discord', { secret: 'https://evil.example/api/webhooks/1/x' }, 'Webhook URL'],
    ['a non-numeric category', 'nginx-community', { username: 'bot', secret: 'k', categoryId: 'general' }, 'Category ID'],
    ['a WordPress site URL with credentials', 'wordpress', { url: 'https://u:p@blog.example.com', username: 'a', secret: 'k' }, 'Site URL'],
    ['an unclear publish flag', 'devto', { username: 'a', secret: 'k', publishNow: 'maybe' }, 'Đăng ngay'],
  ])('rejects %s', (_label, slug, values, message) => {
    const mapped = mapApiImportRow(importRow(values), platform(slug));
    expect(mapped).toMatchObject({ kind: 'skip', status: 'INVALID_ROW' });
    expect(mapped.kind === 'skip' && mapped.message).toContain(message);
  });

  it('never repeats the secret in a validation message', () => {
    const mapped = mapApiImportRow(importRow({ username: 'a.bsky.social', secret: 'my-real-login-password' }), platform('bluesky'));
    expect(JSON.stringify(mapped)).not.toContain('my-real-login-password');
  });

  it('reads a real CSV file through the shared upload parser', async () => {
    const csv = '﻿Nền tảng,Tên hiển thị,URL,Username / Handle,Khoá bí mật,Category ID,Tags,Đăng ngay,Chế độ hiển thị\n'
      + 'dev.to,Dev chính,,alice,key-1,,,có,\n,,,,,,,,\nBluesky,,,bob.bsky.social,abcd-efgh-ijkl-mnop,,,,\n';
    const rows = await parseApiAccountUpload(Buffer.from(csv, 'utf8'), 'csv');
    expect(rows).toEqual([
      importRow({ source: 'upload:2', platform: 'dev.to', name: 'Dev chính', username: 'alice', secret: 'key-1', publishNow: 'có' }),
      importRow({ source: 'upload:4', platform: 'Bluesky', username: 'bob.bsky.social', secret: 'abcd-efgh-ijkl-mnop' }),
    ]);
    await expect(parseApiAccountUpload(Buffer.from('Nền tảng,Username\ndev.to,alice\n'), 'csv')).rejects.toThrow('Cần cột Nền tảng và Khoá bí mật');
    await expect(parseApiAccountUpload(Buffer.from('x'), 'pdf')).rejects.toThrow('XLSX, CSV hoặc TSV');
  });
});
