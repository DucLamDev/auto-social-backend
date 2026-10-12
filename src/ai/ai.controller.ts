import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AiProviderContractDto, ApiOkEnvelope } from '../common/swagger/api-contract.dto';
import { AiContentService } from './ai-content.service';

@ApiTags('ai')
@ApiBearerAuth()
@Controller('ai')
export class AiController {
  constructor(private readonly ai: AiContentService) {}

  @Get('providers')
  @ApiOkEnvelope(AiProviderContractDto, true)
  providers() {
    return this.ai.providers();
  }
}
