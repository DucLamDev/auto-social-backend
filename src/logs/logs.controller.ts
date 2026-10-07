import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { RoleName } from '@prisma/client';
import { Roles } from '../common/decorators/roles.decorator';
import { PrismaService } from '../database/prisma.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/auth.types';
import { ApiOkEnvelope, AuditLogContractDto, PublishAttemptLogContractDto } from '../common/swagger/api-contract.dto';

@ApiTags('logs')
@ApiBearerAuth()
@Controller('logs')
export class LogsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @ApiOkEnvelope(PublishAttemptLogContractDto, true)
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.publishLogs(user);
  }

  @Get('publish')
  @ApiOkEnvelope(PublishAttemptLogContractDto, true)
  listPublishLogs(@CurrentUser() user: AuthenticatedUser) {
    return this.publishLogs(user);
  }

  private publishLogs(user: AuthenticatedUser) {
    return this.prisma.publishAttempt.findMany({
      where: user.roles.includes(RoleName.ADMIN) ? {} : { job: { target: { campaign: { ownerId: user.id } } } },
      include: {
        job: {
          select: {
            id: true,
            status: true,
            platformAccountId: true,
            platformAccount: { select: { name: true, platform: { select: { name: true, slug: true } } } },
            publishedPost: { select: { url: true, externalPostId: true } },
            target: { select: { campaignId: true, contentVariant: { select: { title: true } } } },
          },
        },
      },
      orderBy: { startedAt: 'desc' },
      take: 500,
    });
  }

  @Get('audit')
  @ApiOkEnvelope(AuditLogContractDto, true)
  @Roles(RoleName.ADMIN)
  listAuditLogs() {
    return this.prisma.auditLog.findMany({
      include: { actor: { select: { displayName: true, email: true } } },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
  }
}
