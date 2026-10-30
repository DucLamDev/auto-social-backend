import { Body, Controller, Get, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { RoleName } from '@prisma/client';
import { Roles } from '../common/decorators/roles.decorator';
import { GeminiKeyPoolService } from './gemini-key-pool.service';
import { UpdateGeminiKeysDto } from './gemini-keys.dto';

@ApiTags('settings')
@ApiBearerAuth()
@Roles(RoleName.ADMIN)
@Controller('ai/gemini-keys')
export class GeminiKeysController {
  constructor(private readonly keys: GeminiKeyPoolService) {}
  @Get() get() { return this.keys.describe(); }
  @Put() update(@Body() dto: UpdateGeminiKeysDto) { return this.keys.update(dto); }
}
