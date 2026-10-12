import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

export const MEDIA_ALT_TEXT_MAX_LENGTH = 1_000;

export class UploadMediaDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  contentId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  variantId?: string;

  @ApiPropertyOptional({
    description: 'Accessible description stored with the media asset metadata.',
    maxLength: MEDIA_ALT_TEXT_MAX_LENGTH,
  })
  @IsOptional()
  @IsString()
  @MaxLength(MEDIA_ALT_TEXT_MAX_LENGTH)
  altText?: string;
}
