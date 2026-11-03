import { BadRequestException } from '@nestjs/common';
import { AuthenticatedUser } from '../auth/auth.types';
import { AccountImportController, SHARED_GOOGLE_REMOVED_MESSAGE } from './account-import.controller';
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
});
