import { Body, Controller, Get, Param, Patch, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiTags } from '@nestjs/swagger';
import { RoleName } from '@prisma/client';
import { IsBoolean } from 'class-validator';
import { PlatformsService } from './platforms.service';
import { Roles } from '../common/decorators/roles.decorator';
import { ApiOkEnvelope, PlatformContractDto } from '../common/swagger/api-contract.dto';
import { ListPlatformsQueryDto } from './dto/list-platforms-query.dto';

class TogglePlatformDto { @ApiProperty() @IsBoolean() enabled!: boolean; }

@ApiTags('platforms')
@ApiBearerAuth()
@Controller('platforms')
export class PlatformsController {
  constructor(private readonly platforms: PlatformsService) {}

  @Get()
  @ApiOkEnvelope(PlatformContractDto, true)
  list(@Query() query: ListPlatformsQueryDto) {
    return this.platforms.list(query);
  }

  @Get(':slug')
  @ApiOkEnvelope(PlatformContractDto)
  get(@Param('slug') slug: string) {
    return this.platforms.get(slug);
  }

  @Patch(':slug')
  @ApiOkEnvelope(PlatformContractDto)
  @Roles(RoleName.ADMIN)
  toggle(@Param('slug') slug: string, @Body() dto: TogglePlatformDto) {
    return this.platforms.setEnabled(slug, dto.enabled);
  }
}
