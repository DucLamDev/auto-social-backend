import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsIn, IsOptional } from 'class-validator';

export class ApproveAiCampaignDto {
  @ApiPropertyOptional({ enum: ['NOW', 'SCHEDULED'], default: 'NOW' })
  @IsOptional()
  @IsIn(['NOW', 'SCHEDULED'])
  publishMode?: 'NOW' | 'SCHEDULED';

  @ApiPropertyOptional({ description: 'Future ISO-8601 timestamp with an explicit UTC offset. Required for SCHEDULED.' })
  @IsOptional()
  @IsDateString({ strict: true })
  scheduledAt?: string;
}
