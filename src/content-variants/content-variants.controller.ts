import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { RoleName, VariantStatus } from '@prisma/client';
import { IsArray, IsBoolean, IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/auth.types';
import { ApiCreatedEnvelope, ApiOkEnvelope, ContentVariantContractDto } from '../common/swagger/api-contract.dto';
import { ContentVariantsService } from './content-variants.service';
import { CreateContentVariantDto } from './dto/create-content-variant.dto';

class UpdateVariantStatusDto {
  @ApiProperty({ enum: VariantStatus })
  @IsEnum(VariantStatus)
  status!: VariantStatus;
}

class UpdateVariantDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) title?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() body?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() summary?: string;
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsArray() @IsString({ each: true }) hashtags?: string[];
  @ApiPropertyOptional() @IsOptional() @IsString() cta?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() recommended?: boolean;
  @ApiPropertyOptional({ enum: VariantStatus }) @IsOptional() @IsEnum(VariantStatus) status?: VariantStatus;
}

@ApiTags('content-variants')
@ApiBearerAuth()
@Controller('content-variants')
export class ContentVariantsController {
  constructor(private readonly variants: ContentVariantsService) {}

  @Post()
  @ApiCreatedEnvelope(ContentVariantContractDto)
  @Roles(RoleName.ADMIN, RoleName.EDITOR)
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateContentVariantDto) {
    return this.variants.createManual(user.id, dto);
  }

  @Get()
  @ApiOkEnvelope(ContentVariantContractDto, true)
  list(@CurrentUser() user: AuthenticatedUser, @Query('contentId') contentId?: string) {
    return this.variants.list(user.id, contentId);
  }

  @Patch(':id')
  @ApiOkEnvelope(ContentVariantContractDto)
  @Roles(RoleName.ADMIN, RoleName.EDITOR)
  update(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateVariantDto) {
    return this.variants.updateUnreferenced(user.id, id, dto);
  }

  @Patch(':id/status')
  @ApiOkEnvelope(ContentVariantContractDto)
  @Roles(RoleName.ADMIN, RoleName.EDITOR)
  updateStatus(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateVariantStatusDto) {
    return this.variants.updateUnreferenced(user.id, id, { status: dto.status });
  }
}
