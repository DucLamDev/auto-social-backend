import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsUrl, MaxLength } from 'class-validator';

export class ManualPublishedDto {
  @ApiProperty()
  @IsString()
  @MaxLength(500)
  externalPostId!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUrl({ require_protocol: true })
  url?: string;
}
