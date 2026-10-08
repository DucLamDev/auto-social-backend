import { Body, Controller, Get, Headers, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiTags } from '@nestjs/swagger';
import { RoleName } from '@prisma/client';
import type { Request } from 'express';
import { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { CampaignsService } from './campaigns.service';
import { CreateCampaignDto } from './dto/create-campaign.dto';
import {
  ApiCreatedEnvelope,
  ApiOkEnvelope,
  AutomatedCampaignContractDto,
  CampaignContractDto,
} from '../common/swagger/api-contract.dto';
import { CampaignAutomationService } from './campaign-automation.service';
import { AutomateCampaignDto } from './dto/automate-campaign.dto';

type RequestWithId = Request & { requestId?: string };

@ApiTags('campaigns')
@ApiBearerAuth()
@Controller('campaigns')
export class CampaignsController {
  constructor(
    private readonly campaigns: CampaignsService,
    private readonly automation: CampaignAutomationService,
  ) {}

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

  @Post('automate')
  @ApiCreatedEnvelope(AutomatedCampaignContractDto)
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: 'A UUID or another unique 8-128 character key. Reuse it only when retrying the same request.',
  })
  @Roles(RoleName.ADMIN, RoleName.EDITOR)
  automate(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: AutomateCampaignDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: RequestWithId,
  ) {
    return this.automation.automate(user.id, dto, idempotencyKey, request.requestId);
  }

  @Post(':id/publish')
  @ApiCreatedEnvelope(CampaignContractDto)
  @Roles(RoleName.ADMIN, RoleName.EDITOR)
  publish(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) { return this.campaigns.publish(user.id, id); }
}
