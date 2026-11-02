import { BadRequestException } from '@nestjs/common';
import { RoleName } from '@prisma/client';
import { ROLES_KEY } from '../common/decorators/roles.decorator';
import { AuthenticatedUser } from '../auth/auth.types';
import { ConnectorAccountsService } from '../connectors/connector-accounts.service';
import { ApiAccountImportService } from './api-account-import.service';
import { PlatformAccountsController } from './platform-accounts.controller';
import { PlatformAccountsService } from './platform-accounts.service';

describe('PlatformAccountsController API import', () => {
  const user = { id: 'owner-1' } as AuthenticatedUser;

  function setup() {
    const apiImport = { import: jest.fn().mockResolvedValue({ total: 1, connected: 1, needsAttention: 0, rows: [] }) };
    const controller = new PlatformAccountsController(
      {} as PlatformAccountsService,
      {} as ConnectorAccountsService,
      apiImport as unknown as ApiAccountImportService,
    );
    return { controller, apiImport };
  }

  it('is restricted to administrators', () => {
    const handler = Object.getOwnPropertyDescriptor(PlatformAccountsController.prototype, 'importApi')!.value as object;
    expect(Reflect.getMetadata(ROLES_KEY, handler)).toEqual([RoleName.ADMIN]);
  });

  it('parses the uploaded file and imports its rows for the signed-in owner', async () => {
    const { controller, apiImport } = setup();
    const file = { originalname: 'api-accounts.CSV', buffer: Buffer.from('Nền tảng,Username,Khoá bí mật\ndev.to,alice,k\n') } as Express.Multer.File;

    await controller.importApi(user, file);

    expect(apiImport.import).toHaveBeenCalledWith('owner-1', [expect.objectContaining({ source: 'upload:2', platform: 'dev.to', username: 'alice', secret: 'k' })]);
  });

  it('rejects a missing file or an unsupported file type before importing', async () => {
    const { controller, apiImport } = setup();
    await expect(controller.importApi(user, undefined)).rejects.toBeInstanceOf(BadRequestException);
    await expect(controller.importApi(user, { originalname: 'keys.pdf', buffer: Buffer.from('x') } as Express.Multer.File)).rejects.toThrow('XLSX, CSV hoặc TSV');
    expect(apiImport.import).not.toHaveBeenCalled();
  });
});
