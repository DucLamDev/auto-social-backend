import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RoleName } from '@prisma/client';
import { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { CampaignSuggestionsDto } from './dto/campaign-suggestions.dto';
import { AiImageStatusContractDto, AiProviderContractDto, ApiOkEnvelope } from '../common/swagger/api-contract.dto';
import { AiContentService } from './ai-content.service';
import { AiImageService } from './ai-image.service';

@ApiTags('ai')
@ApiBearerAuth()
@Controller('ai')
export class AiController {
  constructor(private readonly ai: AiContentService, private readonly images: AiImageService) {}

  @Get('providers')
  @ApiOkEnvelope(AiProviderContractDto, true)
  providers() {
    return this.ai.providers();
  }

  @Post('campaign-suggestions')
  @HttpCode(200)
  @Roles(RoleName.ADMIN, RoleName.EDITOR)
  @ApiOperation({ summary: 'Gợi ý chiến dịch và mô tả bài đăng cho các nền tảng đã chọn (một lượt AI, không lưu gì).' })
  suggestCampaigns(@CurrentUser() user: AuthenticatedUser, @Body() dto: CampaignSuggestionsDto) {
    return this.ai.suggestCampaigns(user.id, { platformSlugs: dto.platformSlugs, hint: dto.hint }, dto.aiProvider);
  }

  @Get('image-status')
  @ApiOkEnvelope(AiImageStatusContractDto)
  imageStatus() {
    return this.images.status();
  }
}
