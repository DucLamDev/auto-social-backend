import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { RoleName } from '@prisma/client';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { AuthenticatedUser } from '../auth/auth.types';
import { ContentSourcesService } from './content-sources.service';
import { CreateContentSourceDto } from './dto/create-content-source.dto';
import { ApiCreatedEnvelope, ApiOkEnvelope, ContentSourceContractDto, FetchResultContractDto } from '../common/swagger/api-contract.dto';

@ApiTags('content-sources')
@ApiBearerAuth()
@Controller('content-sources')
export class ContentSourcesController {
  constructor(private readonly sources: ContentSourcesService) {}

  @Get()
  @ApiOkEnvelope(ContentSourceContractDto, true)
  list(@CurrentUser() user: AuthenticatedUser) { return this.sources.list(user.id); }

  @Post()
  @ApiCreatedEnvelope(ContentSourceContractDto)
  @Roles(RoleName.ADMIN, RoleName.EDITOR)
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateContentSourceDto) {
    return this.sources.create(user.id, dto);
  }

  @Post(':id/fetch')
  @ApiCreatedEnvelope(FetchResultContractDto)
  @Roles(RoleName.ADMIN, RoleName.EDITOR)
  fetch(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.sources.fetch(user.id, id);
  }
}
