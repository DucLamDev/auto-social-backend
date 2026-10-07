import { Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { RoleName } from '@prisma/client';
import { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { ContentsService } from '../contents/contents.service';
import { ApiCreatedEnvelope, ApiOkEnvelope, ContentContractDto, SourceArticleContractDto } from '../common/swagger/api-contract.dto';
import { ListSourceArticlesQueryDto } from './dto/list-source-articles-query.dto';
import { SourceArticlesService } from './source-articles.service';

@ApiTags('source-articles')
@ApiBearerAuth()
@Controller('source-articles')
export class SourceArticlesController {
  constructor(private readonly articles: SourceArticlesService, private readonly contents: ContentsService) {}

  @Get()
  @ApiOkEnvelope(SourceArticleContractDto, true)
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: ListSourceArticlesQueryDto) {
    return this.articles.list(user.id, query);
  }

  @Post(':id/promote')
  @ApiCreatedEnvelope(ContentContractDto)
  @Roles(RoleName.ADMIN, RoleName.EDITOR)
  promote(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.contents.promoteSourceArticle(user.id, id);
  }
}
