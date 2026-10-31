import { ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/** Optional edits applied as a new approved variant; omitted fields keep the AI draft. */
export class ApproveContentDto {
  @ApiPropertyOptional({ nullable: true, description: 'New title; null removes it' })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  title?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100_000)
  body?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  hashtags?: string[];
}
