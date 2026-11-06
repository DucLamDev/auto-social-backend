import { BadRequestException, Body, Controller, Delete, Get, Header, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { extname } from 'node:path';
import { RoleName } from '@prisma/client';
import { Roles } from '../common/decorators/roles.decorator';
import { CreatePlatformAccountDto } from './dto/create-platform-account.dto';
import { DeletePlatformAccountsDto } from './dto/delete-platform-accounts.dto';
import { UpdateCredentialDto } from './dto/update-credential.dto';
import { UpdatePlatformAccountDto } from './dto/update-platform-account.dto';
import { UpdatePlatformAccountSettingsDto } from './dto/update-platform-account-settings.dto';
import { PlatformAccountsService } from './platform-accounts.service';
import { parseApiAccountUpload } from './api-account-import';
import { ApiAccountImportService } from './api-account-import.service';
import { ConnectorAccountsService } from '../connectors/connector-accounts.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/auth.types';
import { AccountDeleteResultContractDto, ApiCreatedEnvelope, ApiImportResultContractDto, ApiOkEnvelope, ConnectionTestContractDto, PlatformAccountContractDto } from '../common/swagger/api-contract.dto';

@ApiTags('platform-accounts')
@ApiBearerAuth()
@Controller('platform-accounts')
export class PlatformAccountsController {
  constructor(
    private readonly accounts: PlatformAccountsService,
    private readonly connectorAccounts: ConnectorAccountsService,
    private readonly apiImport: ApiAccountImportService,
  ) {}

  /** Bulk-configures API accounts from an XLSX/CSV/TSV file and tests each connection. Secrets are never returned. */
  @Post('import-api')
  @ApiCreatedEnvelope(ApiImportResultContractDto)
  @Roles(RoleName.ADMIN)
  @Header('Cache-Control', 'no-store')
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: { type: 'object', required: ['file'], properties: { file: { type: 'string', format: 'binary' } } } })
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 2 * 1024 * 1024, files: 1, fields: 0 } }))
  async importApi(@CurrentUser() user: AuthenticatedUser, @UploadedFile() file: Express.Multer.File | undefined) {
    if (!file?.buffer) throw new BadRequestException('Chọn file cấu hình API.');
    const rows = await parseApiAccountUpload(file.buffer, extname(file.originalname).slice(1).toLowerCase());
    return this.apiImport.import(user.id, rows);
  }

  @Get()
  @ApiOkEnvelope(PlatformAccountContractDto, true)
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.accounts.list(user.id);
  }

  @Get(':id')
  @ApiOkEnvelope(PlatformAccountContractDto)
  get(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.accounts.get(user.id, id);
  }

  @Post()
  @ApiCreatedEnvelope(PlatformAccountContractDto)
  @Roles(RoleName.ADMIN)
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreatePlatformAccountDto) {
    return this.accounts.create(user.id, dto);
  }

  @Put(':id/credential')
  @ApiOkEnvelope(PlatformAccountContractDto)
  @Roles(RoleName.ADMIN)
  updateCredential(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateCredentialDto) {
    return this.accounts.updateCredential(user.id, id, dto.credential, dto.settings);
  }

  @Put(':id/settings')
  @ApiOkEnvelope(PlatformAccountContractDto)
  @Roles(RoleName.ADMIN)
  updateSettings(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePlatformAccountSettingsDto,
  ) {
    return this.accounts.updateSettings(user.id, id, dto.settings);
  }

  @Patch(':id')
  @ApiOkEnvelope(PlatformAccountContractDto)
  @Roles(RoleName.ADMIN)
  setEnabled(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdatePlatformAccountDto) {
    return this.accounts.setEnabled(user.id, id, dto.enabled);
  }

  /**
   * Deletes the chosen accounts with their credentials and posting history; accounts with a
   * post waiting or being posted are kept and listed in `blocked`.
   */
  @Post('bulk-delete')
  @HttpCode(200)
  @ApiOkEnvelope(AccountDeleteResultContractDto)
  @Roles(RoleName.ADMIN)
  removeMany(@CurrentUser() user: AuthenticatedUser, @Body() dto: DeletePlatformAccountsDto) {
    return this.accounts.removeMany(user.id, dto.ids);
  }

  @Delete(':id/browser-session')
  @ApiOkEnvelope(PlatformAccountContractDto)
  @Roles(RoleName.ADMIN)
  revokeBrowserSession(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.accounts.revokeBrowserSession(user.id, id);
  }

  @Post(':id/test')
  @ApiCreatedEnvelope(ConnectionTestContractDto)
  @Roles(RoleName.ADMIN, RoleName.EDITOR)
  async testConnection(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.accounts.get(user.id, id);
    return this.connectorAccounts.test(id);
  }
}
