import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

export class ListPublishedPostsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) search?: string;
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID() platformId?: string;
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID() accountId?: string;
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID() campaignId?: string;
  @ApiPropertyOptional({ format: 'date-time' }) @IsOptional() @IsDateString({ strict: true }) from?: string;
  @ApiPropertyOptional({ format: 'date-time' }) @IsOptional() @IsDateString({ strict: true }) to?: string;
}
