import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { RoleName } from '@prisma/client';
import { Roles } from '../common/decorators/roles.decorator';
import { CreatePlatformAccountDto } from './dto/create-platform-account.dto';
import { UpdateCredentialDto } from './dto/update-credential.dto';
import { UpdatePlatformAccountDto } from './dto/update-platform-account.dto';
import { PlatformAccountsService } from './platform-accounts.service';
import { ConnectorAccountsService } from '../connectors/connector-accounts.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/auth.types';
import { ApiCreatedEnvelope, ApiOkEnvelope, ConnectionTestContractDto, PlatformAccountContractDto } from '../common/swagger/api-contract.dto';

@ApiTags('platform-accounts')
@ApiBearerAuth()
@Controller('platform-accounts')
export class PlatformAccountsController {
  constructor(
    private readonly accounts: PlatformAccountsService,
    private readonly connectorAccounts: ConnectorAccountsService,
  ) {}

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

  @Patch(':id')
  @ApiOkEnvelope(PlatformAccountContractDto)
  @Roles(RoleName.ADMIN)
  setEnabled(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdatePlatformAccountDto) {
    return this.accounts.setEnabled(user.id, id, dto.enabled);
  }

  @Post(':id/test')
  @ApiCreatedEnvelope(ConnectionTestContractDto)
  @Roles(RoleName.ADMIN, RoleName.EDITOR)
  async testConnection(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.accounts.get(user.id, id);
    return this.connectorAccounts.test(id);
  }
}
