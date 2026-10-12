import { ApiPropertyOptional } from '@nestjs/swagger';
import { PlatformAvailability, PlatformMode } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsBoolean, IsEnum, IsIn, IsOptional, IsString, Max, MaxLength } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { PLATFORM_GROUP_KEYS, PlatformGroupKey } from '../platform-catalog';

export class ListPlatformsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ type: Number, minimum: 1, maximum: 100, default: 20 })
  @Max(100)
  override limit: number = 20;

  @ApiPropertyOptional({ maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;

  @ApiPropertyOptional({ enum: PLATFORM_GROUP_KEYS })
  @IsOptional()
  @IsIn(PLATFORM_GROUP_KEYS)
  group?: PlatformGroupKey;

  @ApiPropertyOptional({ enum: PlatformMode })
  @IsOptional()
  @IsEnum(PlatformMode)
  mode?: PlatformMode;

  @ApiPropertyOptional({ enum: PlatformAvailability })
  @IsOptional()
  @IsEnum(PlatformAvailability)
  availability?: PlatformAvailability;

  @ApiPropertyOptional({ type: Boolean })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => {
    if (value === 'true') return true;
    if (value === 'false') return false;
    return value;
  })
  @IsBoolean()
  enabled?: boolean;
}
