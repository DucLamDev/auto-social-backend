import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { RoleName } from '@prisma/client';
import { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { CampaignsService } from './campaigns.service';
import { CreateCampaignDto } from './dto/create-campaign.dto';
import { ApiCreatedEnvelope, ApiOkEnvelope, CampaignContractDto } from '../common/swagger/api-contract.dto';

@ApiTags('campaigns')
@ApiBearerAuth()
@Controller('campaigns')
export class CampaignsController {
  constructor(private readonly campaigns: CampaignsService) {}

  @Get()
  @ApiOkEnvelope(CampaignContractDto, true)
  list(@CurrentUser() user: AuthenticatedUser) { return this.campaigns.list(user.id); }

  @Get(':id')
  @ApiOkEnvelope(CampaignContractDto)
  get(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) { return this.campaigns.get(user.id, id); }

  @Post()
  @ApiCreatedEnvelope(CampaignContractDto)
  @Roles(RoleName.ADMIN, RoleName.EDITOR)
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateCampaignDto) { return this.campaigns.create(user.id, dto); }

  @Post(':id/publish')
  @ApiCreatedEnvelope(CampaignContractDto)
  @Roles(RoleName.ADMIN, RoleName.EDITOR)
  publish(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) { return this.campaigns.publish(user.id, id); }
}
