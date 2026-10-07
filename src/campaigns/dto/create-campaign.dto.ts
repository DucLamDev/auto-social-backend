import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsDateString, IsObject, IsOptional, IsString, IsUUID, MaxLength, ValidateNested } from 'class-validator';

export class CampaignTargetDto {
  @ApiProperty()
  @IsUUID()
  platformAccountId!: string;

  @ApiProperty()
  @IsUUID()
  contentVariantId!: string;

  @ApiPropertyOptional({ type: 'object', additionalProperties: true })
  @IsOptional()
  @IsObject()
  overrides?: Record<string, unknown>;
}

export class CreateCampaignDto {
  @ApiProperty()
  @IsString()
  @MaxLength(160)
  name!: string;

  @ApiProperty()
  @IsUUID()
  contentId!: string;

  @ApiPropertyOptional({ description: 'ISO-8601 timestamp with an explicit offset' })
  @IsOptional()
  @IsDateString({ strict: true })
  scheduledAt?: string;

  @ApiPropertyOptional({ example: 'Asia/Ho_Chi_Minh', default: 'UTC' })
  @IsOptional()
  @IsString()
  timezone?: string;

  @ApiProperty({ type: [CampaignTargetDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(1000)
  @ValidateNested({ each: true })
  @Type(() => CampaignTargetDto)
  targets!: CampaignTargetDto[];
}
