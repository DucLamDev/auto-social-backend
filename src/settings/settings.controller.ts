import { Body, Controller, Get, Param, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiTags } from '@nestjs/swagger';
import { Prisma, RoleName } from '@prisma/client';
import { IsBoolean, IsObject, IsOptional, IsString } from 'class-validator';
import { Roles } from '../common/decorators/roles.decorator';
import { PrismaService } from '../database/prisma.service';
import { CredentialEncryptionService } from '../credentials/credential-encryption.service';
import { BadRequestException } from '@nestjs/common';
import { ApiOkEnvelope, SystemSettingContractDto } from '../common/swagger/api-contract.dto';

class UpdateSettingDto {
  @ApiProperty({ type: 'object', additionalProperties: true })
  @IsObject()
  value!: Record<string, unknown>;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsBoolean() secret?: boolean;
}

@ApiTags('settings')
@ApiBearerAuth()
@Roles(RoleName.ADMIN)
@Controller('settings')
export class SettingsController {
  constructor(private readonly prisma: PrismaService, private readonly encryption: CredentialEncryptionService) {}

  @Get()
  @ApiOkEnvelope(SystemSettingContractDto, true)
  async list() {
    const settings = await this.prisma.systemSetting.findMany({ orderBy: { key: 'asc' } });
    return settings.map((setting) => ({ ...setting, value: setting.secret ? { configured: true } : setting.value }));
  }

  @Put(':key')
  @ApiOkEnvelope(SystemSettingContractDto)
  async upsert(@Param('key') key: string, @Body() dto: UpdateSettingDto) {
    if (key === 'ai.gemini.keys') throw new BadRequestException('Use the Gemini API key settings form.');
    if (!/^[a-zA-Z0-9_.-]{1,100}$/.test(key)) throw new BadRequestException('Invalid setting key');
    const existing = await this.prisma.systemSetting.findUnique({ where: { key }, select: { secret: true } });
    const effectiveSecret = dto.secret ?? existing?.secret ?? false;
    const value = (effectiveSecret
      ? { encrypted: this.encryption.encrypt(dto.value), keyVersion: this.encryption.keyVersion }
      : dto.value) as Prisma.InputJsonObject;
    const setting = await this.prisma.systemSetting.upsert({
      where: { key },
      create: { key, value, description: dto.description, secret: effectiveSecret },
      update: { value, description: dto.description, secret: effectiveSecret },
    });
    return { ...setting, value: setting.secret ? { configured: true } : setting.value };
  }
}
