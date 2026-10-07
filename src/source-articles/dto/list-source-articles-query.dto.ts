import { ApiPropertyOptional } from '@nestjs/swagger';
import { SourceArticleStatus } from '@prisma/client';
import { IsEnum, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

export class ListSourceArticlesQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;

  @ApiPropertyOptional({ enum: SourceArticleStatus })
  @IsOptional()
  @IsEnum(SourceArticleStatus)
  status?: SourceArticleStatus;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  sourceId?: string;
}
