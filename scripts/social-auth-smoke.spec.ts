import { authRecordsFromTsv, generateTotp, parseTsv } from './social-auth-smoke';

describe('social auth smoke helpers', () => {
  it('parses tab-delimited records with quoted tabs, quotes, and newlines', () => {
    const source = ['A\tB\tC', '1\t"two\tparts"\t"line one', 'line ""two"""', '2\tplain\t'].join(
      '\r\n',
    );

    expect(parseTsv(source)).toEqual([
      ['A', 'B', 'C'],
      ['1', 'two\tparts', 'line one\r\nline "two"'],
      ['2', 'plain', ''],
    ]);
  });

  it('loads the expected auth columns without exposing optional trailing cells', () => {
    const source = [
      'STT\tSocial Network\tURL Đăng nhập\tPhương thức Login\tUser\tPass\t2fa\tURL Profile\tIndex\tMô tả Nền tảng',
      '1\tdev.to\thttps://dev.to/enter\tGmail / Google Auth\tuser-value\t" pass-value "\tTOTP-VALUE\thttps://dev.to/profile\t\t"multi',
      'line"',
      '2\t\t\t\t\t\t\t\t\t',
    ].join('\n');

    const records = authRecordsFromTsv(source);

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      sequence: '1',
      platform: 'dev.to',
      loginUrl: 'https://dev.to/enter',
      loginMethod: 'Gmail / Google Auth',
      user: 'user-value',
      password: ' pass-value ',
      twoFactor: 'TOTP-VALUE',
      profileUrl: 'https://dev.to/profile',
    });
  });

  it('accepts the mojibake header names produced by the supplied TSV export', () => {
    const source = [
      'STT\tSocial Network\tURL ??ng nh?p\tPh??ng th?c Login\tUser\tPass\t2fa\tURL Profile\tIndex\tM� t? N?n t?ng',
      '1\tdev.to\thttps://dev.to/enter\tGmail / Google Auth\tuser-value\tpass-value\t\t\t\t',
    ].join('\n');

    expect(authRecordsFromTsv(source)).toHaveLength(1);
  });

  it('matches the RFC 6238 SHA-1 test vector', () => {
    expect(
      generateTotp(
        {
          secret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
          algorithm: 'sha1',
          digits: 8,
          period: 30,
        },
        59_000,
      ),
    ).toBe('94287082');
  });

  it('rejects records wider than the declared header', () => {
    const source = [
      'STT\tSocial Network\tURL Login\tLogin\tUser\tPass\t2fa\tURL Profile',
      '1\tdev.to\thttps://dev.to\tEmail\tuser\tpass\t\t\textra-cell',
    ].join('\n');

    expect(() => authRecordsFromTsv(source)).toThrow('AUTH_FILE_ROW_TOO_WIDE');
  });
});
