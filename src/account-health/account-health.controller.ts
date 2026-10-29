import { Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RoleName } from '@prisma/client';
import { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { AccountHealthService } from './account-health.service';
import { AccountHealthContractDto, ApiOkEnvelope, MaintenanceRunContractDto } from '../common/swagger/api-contract.dto';

@ApiTags('account-health')
@ApiBearerAuth()
@Controller('account-health')
export class AccountHealthController {
  constructor(private readonly health: AccountHealthService) {}

  @Get()
  @ApiOkEnvelope(AccountHealthContractDto)
  @ApiOperation({ summary: 'Accounts needing reconnection, tokens expiring soon and publish jobs needing an operator' })
  attention(@CurrentUser() user: AuthenticatedUser) {
    return this.health.attention(user.id);
  }

  @Post('check')
  @HttpCode(HttpStatus.OK)
  @Roles(RoleName.ADMIN)
  @ApiOkEnvelope(MaintenanceRunContractDto)
  @ApiOperation({ summary: 'Refresh due Meta tokens and test every connected account of the current user now' })
  async check(@CurrentUser() user: AuthenticatedUser) {
    const tokens = await this.health.refreshMetaTokens();
    const connections = await this.health.checkConnections(user.id);
    return { tokens, connections };
  }
}
