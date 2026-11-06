import { Body, Controller, Delete, Get, Headers, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
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
  DeletedCampaignContractDto,
} from '../common/swagger/api-contract.dto';
import { CampaignAutomationService } from './campaign-automation.service';
import { AutomateCampaignDto } from './dto/automate-campaign.dto';
import { ApproveAiCampaignDto } from './dto/approve-ai-campaign.dto';
import { ReviewExistingContentDto } from './dto/review-existing-content.dto';

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

  @Get('ai-review')
  @ApiOkEnvelope(CampaignContractDto, true)
  listAiReview(@CurrentUser() user: AuthenticatedUser) { return this.campaigns.listAiReview(user.id); }

  @Post('review-content/:contentId')
  @ApiCreatedEnvelope(AutomatedCampaignContractDto)
  @Roles(RoleName.ADMIN, RoleName.EDITOR)
  reviewContent(@CurrentUser() user: AuthenticatedUser, @Param('contentId', ParseUUIDPipe) contentId: string, @Body() dto: ReviewExistingContentDto) {
    return this.automation.approveExistingContent(user.id, contentId, dto);
  }

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
    return this.automation.automate(user.id, dto, idempotencyKey, request.requestId, { enqueue: true });
  }

  @Post(':id/approve')
  @ApiCreatedEnvelope(AutomatedCampaignContractDto)
  @Roles(RoleName.ADMIN, RoleName.EDITOR)
  approve(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ApproveAiCampaignDto) { return this.automation.approve(user.id, id, dto); }

  @Post(':id/variants/:variantId/approve')
  @ApiCreatedEnvelope(AutomatedCampaignContractDto)
  @Roles(RoleName.ADMIN, RoleName.EDITOR)
  approveVariant(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string, @Param('variantId', ParseUUIDPipe) variantId: string, @Body() dto: ApproveAiCampaignDto) {
    return this.automation.approveVariant(user.id, id, variantId, dto);
  }

  @Post(':id/variants/:variantId/reject')
  @ApiCreatedEnvelope(AutomatedCampaignContractDto)
  @Roles(RoleName.ADMIN, RoleName.EDITOR)
  rejectVariant(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string, @Param('variantId', ParseUUIDPipe) variantId: string) {
    return this.automation.rejectVariant(user.id, id, variantId);
  }

  @Post(':id/restore')
  @ApiCreatedEnvelope(AutomatedCampaignContractDto)
  @Roles(RoleName.ADMIN, RoleName.EDITOR)
  restore(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.automation.restore(user.id, id);
  }

  @Post(':id/variants/:variantId/restore')
  @ApiCreatedEnvelope(AutomatedCampaignContractDto)
  @Roles(RoleName.ADMIN, RoleName.EDITOR)
  restoreVariant(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string, @Param('variantId', ParseUUIDPipe) variantId: string) {
    return this.automation.restore(user.id, id, variantId);
  }

  @Post(':id/retry-generation')
  @ApiCreatedEnvelope(AutomatedCampaignContractDto)
  @Roles(RoleName.ADMIN, RoleName.EDITOR)
  retry(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) { return this.automation.retry(user.id, id); }

  @Post(':id/reject')
  @ApiCreatedEnvelope(AutomatedCampaignContractDto)
  @Roles(RoleName.ADMIN, RoleName.EDITOR)
  reject(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) { return this.automation.reject(user.id, id); }

  /** Removes an AI run from "Content đợi duyệt" (not while writing, publishing or once a post is live). */
  @Delete(':id')
  @ApiOkEnvelope(DeletedCampaignContractDto)
  @Roles(RoleName.ADMIN, RoleName.EDITOR)
  remove(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) { return this.automation.remove(user.id, id); }

  @Post(':id/publish')
  @ApiCreatedEnvelope(CampaignContractDto)
  @Roles(RoleName.ADMIN, RoleName.EDITOR)
  publish(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) { return this.campaigns.publish(user.id, id); }
}
