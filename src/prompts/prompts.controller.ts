import { Body, Controller, Get, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { RoleName } from '@prisma/client';
import { Roles } from '../common/decorators/roles.decorator';
import { UpsertPromptDto } from './dto/upsert-prompt.dto';
import { PromptsService } from './prompts.service';
import { ApiCreatedEnvelope, ApiOkEnvelope, PromptTemplateContractDto } from '../common/swagger/api-contract.dto';

@ApiTags('prompts')
@ApiBearerAuth()
@Controller('prompts')
export class PromptsController {
  constructor(private readonly prompts: PromptsService) {}

  @Get()
  @ApiOkEnvelope(PromptTemplateContractDto, true)
  list() { return this.prompts.list(); }

  @Post()
  @ApiCreatedEnvelope(PromptTemplateContractDto)
  @Roles(RoleName.ADMIN)
  createVersion(@Body() dto: UpsertPromptDto) { return this.prompts.createVersion(dto); }
}
