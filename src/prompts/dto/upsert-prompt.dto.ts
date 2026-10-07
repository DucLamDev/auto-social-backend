import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsObject, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class UpsertPromptDto {
  @ApiProperty({ example: 'linkedin' })
  @IsString()
  platformSlug!: string;

  @ApiProperty()
  @IsString()
  @MaxLength(120)
  name!: string;

  @ApiProperty()
  @IsString()
  @MinLength(10)
  systemPrompt!: string;

  @ApiProperty({ description: 'Supports {{platform}}, {{title}}, {{body}}, {{summary}}, {{canonicalUrl}}' })
  @IsString()
  @MinLength(10)
  userTemplate!: string;

  @ApiPropertyOptional({ type: 'object', additionalProperties: true })
  @IsOptional()
  @IsObject()
  schema?: Record<string, unknown>;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}
