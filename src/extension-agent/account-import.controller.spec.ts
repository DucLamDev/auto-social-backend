import { BadRequestException } from '@nestjs/common';
import { AuthenticatedUser } from '../auth/auth.types';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AccountImportController, ImportOneAccountDto, SHARED_GOOGLE_REMOVED_MESSAGE } from './account-import.controller';
import { AccountImportService } from './account-import.service';

const user = { id: 'owner-1', email: 'admin@example.test', displayName: 'Admin', roles: ['ADMIN'] } as unknown as AuthenticatedUser;
const deviceId = '7d0f1a2e-3b4c-4d5e-8f60-718293a4b5c6';
const csv = { buffer: Buffer.from('Social Network,User,Pass\nMastodon.social,alice,fixture-pass\n'), originalname: 'accounts.csv' } as Express.Multer.File; // vpsttt-secretscan: ignore (mật khẩu giả cho test)

function setup() {
  const importer = { import: jest.fn().mockResolvedValue({ imported: 1, queued: 1, batchId: 'b', rows: [] }) };
  return { importer, controller: new AccountImportController(importer as unknown as AccountImportService) };
}

describe('AccountImportController', () => {
  it.each(['googleEmail', 'googlePassword', 'googleTotpSecret'])('explains that the removed shared Google %s is no longer used', async (field) => {
    const { controller, importer } = setup();
    const call = controller.upload(user, csv, { deviceId, [field]: 'company@example.test' });
    await expect(call).rejects.toBeInstanceOf(BadRequestException);
    await expect(call).rejects.toThrow(SHARED_GOOGLE_REMOVED_MESSAGE);
    expect(importer.import).not.toHaveBeenCalled();
  });

  it('imports with the per-row logins when the old fields are absent or blank', async () => {
    const { controller, importer } = setup();
    await controller.upload(user, csv, { deviceId, googleEmail: '  ' });
    expect(importer.import).toHaveBeenCalledWith('owner-1', deviceId, [expect.objectContaining({ platform: 'mastodon', loginUsername: 'alice' })]);
  });

  it('adds one social through the same import as a file row, without the password in the source', async () => {
    const { controller, importer } = setup();
    await controller.one(user, { deviceId, platform: 'daily-dev', provider: 'google', loginUsername: ' writer@example.test ', password: 'fixture-google', // vpsttt-secretscan: ignore (mật khẩu giả cho test)
      totpSecret: 'JBSW Y3DP EHPK 3PXP', expectedUsername: '@writer', profileUrl: 'https://app.daily.dev/writer' });
    expect(importer.import).toHaveBeenCalledWith('owner-1', deviceId, [{
      source: 'manual:1', platform: 'daily-dev', label: 'daily-dev', provider: 'google', loginUsername: 'writer@example.test',
      password: 'fixture-google', totpSecret: 'JBSWY3DPEHPK3PXP', profileUrl: 'https://app.daily.dev/writer', expectedUsername: 'writer', // vpsttt-secretscan: ignore (mật khẩu giả cho test)
      targetUrl: undefined, tags: undefined, category: undefined,
    }]);
  });

  it('refuses a malformed social before it reaches the import', async () => {
    const errors = async (value: Record<string, unknown>) => (await validate(plainToInstance(ImportOneAccountDto, value))).map((error) => error.property).sort();
    const valid = { deviceId, platform: 'daily-dev', provider: 'google', loginUsername: 'writer@example.test' };
    expect(await errors(valid)).toEqual([]);
    expect(await errors({ ...valid, platform: '../etc', provider: 'facebook', profileUrl: 'http://app.daily.dev/writer', targetUrl: 'javascript:alert(1)' }))
      .toEqual(['platform', 'profileUrl', 'provider', 'targetUrl']);
    expect(await errors({ ...valid, deviceId: 'not-a-chrome', loginUsername: '' })).toEqual(['deviceId', 'loginUsername']);
  });
});
