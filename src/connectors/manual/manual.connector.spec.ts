import { ManualConnector } from './manual.connector';

describe('ManualConnector', () => {
  const connector = new ManualConnector('manual');

  it('reports truthful manual readiness without requiring a secret', async () => {
    await expect(connector.testConnection({
      id: 'account-1',
      settings: { manualUrl: 'https://medium.com/new-story' },
      credentials: {},
    })).resolves.toMatchObject({
      ok: true,
      manual: true,
      ready: true,
    });
  });

  it('creates a needs-action result instead of claiming publication', async () => {
    const result = await connector.publish(
      { id: 'account-1', settings: {}, credentials: {} },
      { body: 'Prepared post', idempotencyKey: 'job-1' },
    );
    expect(result.status).toBe('NEEDS_ACTION');
    expect(String(result.metadata?.reason)).toContain('manual');
  });
});
