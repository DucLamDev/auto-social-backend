import { Body, Controller, Get, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { RoleName } from '@prisma/client';
import { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { ApiOkEnvelope } from '../common/swagger/api-contract.dto';
import { BrandProfileViewDto, UpdateBrandProfileDto } from './brand-profile.dto';
import { BrandProfileService } from './brand-profile.service';

/** The brand profile the AI writes with, edited in Settings. */
@ApiTags('settings')
@ApiBearerAuth()
@Roles(RoleName.ADMIN)
@Controller('ai/brand-profile')
export class BrandProfileController {
  constructor(private readonly profiles: BrandProfileService) {}

  @Get()
  @ApiOkEnvelope(BrandProfileViewDto)
  get() { return this.profiles.view(); }

  @Put()
  @ApiOkEnvelope(BrandProfileViewDto)
  update(@Body() dto: UpdateBrandProfileDto, @CurrentUser() user: AuthenticatedUser) { return this.profiles.save(dto.profile, user.id); }
}
