import { ApiProperty } from '@nestjs/swagger';
import { IsDateString } from 'class-validator';

export class PublishJobMetricsQueryDto {
  @ApiProperty({ format: 'date-time', description: 'Start of the user-local day converted to UTC' })
  @IsDateString({ strict: true })
  todayFrom!: string;

  @ApiProperty({ format: 'date-time', description: 'End of the user-local day converted to UTC' })
  @IsDateString({ strict: true })
  todayTo!: string;
}
