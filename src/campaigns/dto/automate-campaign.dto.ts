import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsDateString,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

export class AutomateCampaignDto {
  @ApiProperty({ example: 'Ra mắt sản phẩm VPS mới' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(160)
  name!: string;

  @ApiProperty({
    description: 'Thông tin nguồn để AI viết các biến thể riêng cho từng nền tảng.',
    example: 'Quảng bá gói VPS hiệu năng cao cho lập trình viên, tập trung vào backup và hỗ trợ 24/7.',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100_000)
  brief!: string;

  @ApiProperty({ type: [String], format: 'uuid' })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ArrayUnique()
  @IsUUID('4', { each: true })
  platformAccountIds!: string[];

  @ApiPropertyOptional({ description: 'ISO-8601 timestamp with Z or an explicit UTC offset.' })
  @IsOptional()
  @IsDateString({ strict: true })
  scheduledAt?: string;

  @ApiPropertyOptional({ example: 'Asia/Ho_Chi_Minh', default: 'UTC' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  timezone?: string;

  @ApiPropertyOptional({
    default: true,
    description: 'Activate the generated campaign automatically. A future scheduledAt is still queued for that time.',
  })
  @IsOptional()
  @IsBoolean()
  publishImmediately?: boolean;
}
