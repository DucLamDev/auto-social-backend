import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsBoolean, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class GeminiKeyChangeDto {
  @ApiProperty({ minimum: 1, maximum: 10 }) @IsInt() @Min(1) @Max(10) slot!: number;
  @ApiPropertyOptional({ writeOnly: true }) @IsOptional() @IsString() @MinLength(10) @MaxLength(2048) @Matches(/^\S+$/) apiKey?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() clear?: boolean;
}

export class UpdateGeminiKeysDto {
  @ApiProperty() @IsString() @MaxLength(50) revision!: string;
  @ApiProperty({ type: [GeminiKeyChangeDto], maxItems: 10 })
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(10) @ArrayUnique((item: GeminiKeyChangeDto | null) => item?.slot)
  @ValidateNested({ each: true }) @Type(() => GeminiKeyChangeDto) changes!: GeminiKeyChangeDto[];
}
