import { accountTotpEnvironmentKey, createAccountTotpProvider, generateTotp } from './totp-provider';

// Public RFC 6238 Appendix B test vectors; these are not account secrets.
function base32(text: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  let encoded = '';
  for (const byte of Buffer.from(text, 'ascii')) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) { bits -= 5; encoded += alphabet[(value >>> bits) & 31]; }
    value &= (1 << bits) - 1;
  }
  if (bits) encoded += alphabet[(value << (5 - bits)) & 31];
  return encoded;
}
const fixtures = {
  SHA1: base32('12345678901234567890'),
  SHA256: base32('12345678901234567890123456789012'),
  SHA512: base32('1234567890123456789012345678901234567890123456789012345678901234'),
};
const accountId = '12345678-1234-1234-1234-123456789abc';

describe('Owner-configured TOTP provider', () => {
  afterEach(() => jest.useRealTimers());
  it.each([
    [59, '94287082', '46119246', '90693936'],
    [1111111109, '07081804', '68084774', '25091201'],
    [1111111111, '14050471', '67062674', '99943326'],
    [1234567890, '89005924', '91819424', '93441116'],
    [2000000000, '69279037', '90698825', '38618901'],
    [20000000000, '65353130', '77737706', '47863826'],
  ])('matches RFC 6238 at time %s', (time, sha1, sha256, sha512) => {
    for (const [algorithm, expected] of [['SHA1', sha1], ['SHA256', sha256], ['SHA512', sha512]] as const) {
      const uri = `otpauth://totp/RFC-fixture?secret=${fixtures[algorithm]}&algorithm=${algorithm}&digits=8`;
      expect(generateTotp(uri, Number(time) * 1000)).toBe(expected);
    }
  });
  it('supports raw Base32 seeds with six-digit default', () => {
    expect(generateTotp(fixtures.SHA1.toLowerCase(), 59_000)).toBe('287082');
  });
  it.each(['', 'not|a-secret', 'INVALID-SEED', 'AAAAAAAAAAAAAAAAB',
    'otpauth://hotp/test?secret=invalid', 'otpauth://totp/test?secret=invalid&algorithm=MD5',
    'otpauth://totp/test?secret=invalid&digits=5', 'otpauth://totp/test?secret=invalid&period=0'])('rejects invalid config without including its value', (invalid) => {
    expect(() => generateTotp(invalid, 59_000)).toThrow('TOTP configuration is missing or invalid');
    try { generateTotp(invalid, 59_000); } catch (error) {
      if (invalid) expect((error as Error).message).not.toContain(invalid);
    }
  });
  it('does not read any secret until explicitly enabled and invoked for the account', async () => {
    jest.useFakeTimers().setSystemTime(40_000);
    const read = jest.fn().mockReturnValue(fixtures.SHA1);
    expect(createAccountTotpProvider(accountId, {}, read)).toBeUndefined();
    const provider = createAccountTotpProvider(accountId, { browserAutoTotp: true, totpSecretEnv: 'OTHER_ACCOUNT' }, read)!;
    expect(read).not.toHaveBeenCalled();
    await expect(provider(new AbortController().signal)).resolves.toMatch(/^\d{6}$/);
    expect(read).toHaveBeenCalledWith('BROWSER_TOTP_SECRET_12345678_1234_1234_1234_123456789ABC');
  });
  it('rejects an invalid account id without reading env secrets', () => {
    expect(() => accountTotpEnvironmentKey('../../other-account')).toThrow('TOTP configuration');
  });
  it('fails closed when an enabled account has no configured seed', async () => {
    const provider = createAccountTotpProvider(accountId, { browserAutoTotp: true }, () => undefined)!;
    await expect(provider(new AbortController().signal)).rejects.toThrow('TOTP configuration');
  });
  it('waits for a fresh current code when less than five seconds remain', async () => {
    jest.useFakeTimers().setSystemTime(29_000);
    const provider = createAccountTotpProvider(accountId, { browserAutoTotp: true }, () => fixtures.SHA1)!;
    const result = provider(new AbortController().signal);
    await jest.advanceTimersByTimeAsync(1100);
    await expect(result).resolves.toBe(generateTotp(fixtures.SHA1, 30_100));
    expect(jest.getTimerCount()).toBe(0);
  });
  it('cancels the period wait without generating another code', async () => {
    jest.useFakeTimers().setSystemTime(29_000);
    const abort = new AbortController();
    const provider = createAccountTotpProvider(accountId, { browserAutoTotp: true }, () => fixtures.SHA1)!;
    const result = provider(abort.signal);
    abort.abort();
    await expect(result).rejects.toThrow();
    expect(jest.getTimerCount()).toBe(0);
  });
});
