import { ApiPropertyOptional } from '@nestjs/swagger';
import { PublishJobStatus } from '@prisma/client';
import { IsDateString, IsEnum, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

export class ListPublishJobsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: ['MODERATION'] })
  @IsOptional()
  @IsIn(['MODERATION'])
  reviewState?: 'MODERATION';

  @ApiPropertyOptional({ enum: PublishJobStatus })
  @IsOptional()
  @IsEnum(PublishJobStatus)
  status?: PublishJobStatus;

  @ApiPropertyOptional({ maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;

  @ApiPropertyOptional({ format: 'date-time' })
  @IsOptional()
  @IsDateString({ strict: true })
  from?: string;

  @ApiPropertyOptional({ format: 'date-time' })
  @IsOptional()
  @IsDateString({ strict: true })
  to?: string;
}
