import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { RoleName } from '@prisma/client';
import { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { ManualPublishedDto } from './dto/manual-published.dto';
import { PublishJobsService } from './publish-jobs.service';
import { ApiCreatedEnvelope, ApiOkEnvelope, ManualPayloadContractDto, MutationResultContractDto, PublishJobContractDto } from '../common/swagger/api-contract.dto';
import { ListPublishJobsQueryDto } from './dto/list-publish-jobs-query.dto';
import { PublishJobMetricsQueryDto } from './dto/publish-job-metrics-query.dto';
import { PublishJobMetricsContractDto } from '../common/swagger/api-contract.dto';
import { ReconcileNotFoundDto } from './dto/reconcile-not-found.dto';

@ApiTags('publish-jobs')
@ApiBearerAuth()
@Controller('publish-jobs')
export class PublishJobsController {
  constructor(private readonly jobs: PublishJobsService) {}

  @Get()
  @ApiOkEnvelope(PublishJobContractDto, true)
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: ListPublishJobsQueryDto) {
    return this.jobs.list(user.id, query);
  }

  @Get('metrics')
  @ApiOkEnvelope(PublishJobMetricsContractDto)
  metrics(@CurrentUser() user: AuthenticatedUser, @Query() query: PublishJobMetricsQueryDto) {
    return this.jobs.metrics(user.id, query);
  }

  @Get(':id/manual-payload')
  @ApiOkEnvelope(ManualPayloadContractDto)
  manualPayload(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.jobs.manualPayload(user.id, id);
  }

  @Post(':id/retry')
  @ApiCreatedEnvelope(MutationResultContractDto)
  @Roles(RoleName.ADMIN, RoleName.EDITOR)
  retry(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) { return this.jobs.retry(user.id, id); }

  @Post(':id/reconcile-not-found')
  @ApiCreatedEnvelope(MutationResultContractDto)
  @Roles(RoleName.ADMIN, RoleName.EDITOR)
  reconcileNotFound(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReconcileNotFoundDto,
  ) {
    return this.jobs.reconcileNotFound(user.id, id, dto.confirmedNotFound);
  }

  @Post(':id/mark-published')
  @ApiCreatedEnvelope(MutationResultContractDto)
  @Roles(RoleName.ADMIN, RoleName.EDITOR)
  markPublished(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ManualPublishedDto) {
    return this.jobs.markPublished(user.id, id, dto);
  }
}
