import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { PrismaService } from '../database/prisma.service';
import { ApiOkEnvelope, PublishedPostContractDto } from '../common/swagger/api-contract.dto';

@ApiTags('published-posts')
@ApiBearerAuth()
@Controller('published-posts')
export class PublishedPostsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @ApiOkEnvelope(PublishedPostContractDto, true)
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.prisma.publishedPost.findMany({
      where: { job: { target: { campaign: { ownerId: user.id } } } },
      include: { platformAccount: { select: { id: true, name: true, platform: { select: { slug: true, name: true } } } }, job: { select: { id: true, target: { select: { campaign: { select: { id: true, name: true } } } } } } },
      orderBy: { publishedAt: 'desc' },
      take: 200,
    });
  }
}
