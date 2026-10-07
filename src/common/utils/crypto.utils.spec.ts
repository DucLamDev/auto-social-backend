import { sha256, stableIdempotencyKey } from './crypto.utils';

describe('crypto utils', () => {
  it('produces deterministic, target-specific idempotency keys', () => {
    const first = stableIdempotencyKey('campaign', 'account-a', 'variant');
    expect(first).toBe(stableIdempotencyKey('campaign', 'account-a', 'variant'));
    expect(first).not.toBe(stableIdempotencyKey('campaign', 'account-b', 'variant'));
    expect(first).toHaveLength(64);
  });

  it('hashes without retaining plaintext', () => {
    expect(sha256('refresh-token')).not.toContain('refresh-token');
  });
});
