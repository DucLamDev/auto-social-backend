import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { RoleName } from '@prisma/client';
import { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { ContentsService } from './contents.service';
import { CreateContentDto } from './dto/create-content.dto';
import { AiContentService } from '../ai/ai-content.service';
import { GenerateContentDto } from '../ai/dto/generate-content.dto';
import { ApiCreatedEnvelope, ApiOkEnvelope, ContentContractDto, ContentVariantContractDto } from '../common/swagger/api-contract.dto';
import { ListContentsQueryDto } from './dto/list-contents-query.dto';

@ApiTags('contents')
@ApiBearerAuth()
@Controller('contents')
export class ContentsController {
  constructor(private readonly contents: ContentsService, private readonly ai: AiContentService) {}

  @Get()
  @ApiOkEnvelope(ContentContractDto, true)
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: ListContentsQueryDto) {
    return this.contents.list(user.id, query);
  }

  @Get(':id')
  @ApiOkEnvelope(ContentContractDto)
  get(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) { return this.contents.get(user.id, id); }

  @Post()
  @ApiCreatedEnvelope(ContentContractDto)
  @Roles(RoleName.ADMIN, RoleName.EDITOR)
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateContentDto) { return this.contents.create(user.id, dto); }

  @Post(':id/generate')
  @ApiCreatedEnvelope(ContentVariantContractDto, true)
  @Roles(RoleName.ADMIN, RoleName.EDITOR)
  generate(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: GenerateContentDto,
  ) {
    return this.ai.generate(user.id, id, dto.platforms, dto.aiProvider);
  }
}
