import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
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

  @Get('image-status')
  @ApiOkEnvelope(AiImageStatusContractDto)
  imageStatus() {
    return this.images.status();
  }
}
