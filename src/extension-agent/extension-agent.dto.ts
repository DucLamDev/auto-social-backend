import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsOptional, IsString, IsUrl, Length, MaxLength } from 'class-validator';

export const EXTENSION_NEEDS_ACTION_REASONS = ['CAPTCHA_REQUIRED', 'WAITING_USER', 'SUBMIT_UNCONFIRMED', 'SUBMIT_REJECTED'] as const;
/** Reasons the extension reports only when nothing was submitted, so a retry cannot duplicate the post. */
export const EXTENSION_FAILED_REASONS = ['LOGIN_REQUIRED', 'EDITOR_NOT_FOUND', 'PERMISSION_REQUIRED', 'PAGE_LOAD_FAILED', 'CANCELLED'] as const;

export class CreateExtensionDeviceDto {
  @ApiProperty({ example: 'Chrome văn phòng' })
  @IsString()
  @Length(2, 80)
  name!: string;
}

export class ExtensionTaskResultDto {
  @ApiProperty({ enum: ['PUBLISHED', 'NEEDS_ACTION', 'FAILED'] })
  @IsIn(['PUBLISHED', 'NEEDS_ACTION', 'FAILED'])
  outcome!: 'PUBLISHED' | 'NEEDS_ACTION' | 'FAILED';

  @ApiPropertyOptional({ description: 'Thread URL once the post exists' })
  @IsOptional()
  @IsUrl({ require_protocol: true, require_tld: false, protocols: ['http', 'https'] })
  @MaxLength(2048)
  url?: string;

  @ApiPropertyOptional({ enum: [...EXTENSION_NEEDS_ACTION_REASONS, ...EXTENSION_FAILED_REASONS] })
  @IsOptional()
  @IsIn([...EXTENSION_NEEDS_ACTION_REASONS, ...EXTENSION_FAILED_REASONS])
  reason?: (typeof EXTENSION_NEEDS_ACTION_REASONS)[number] | (typeof EXTENSION_FAILED_REASONS)[number];

  @ApiPropertyOptional({ description: 'Short text shown to the operator (forum error banner, etc.)' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  message?: string;
}

export class ExtensionDeliveryDto {
  @ApiProperty({ description: 'true: publish through the paired Chrome extension' })
  @IsBoolean()
  enabled!: boolean;

  @ApiPropertyOptional({ enum: ['xenforo', 'discourse', 'phpbb'] })
  @IsOptional()
  @IsIn(['xenforo', 'discourse', 'phpbb'])
  engine?: 'xenforo' | 'discourse' | 'phpbb';

  @ApiPropertyOptional({ example: 'https://voz.vn/f/chuyen-tro-linh-tinh.17/post-thread' })
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  targetUrl?: string;

  @ApiPropertyOptional({ description: 'false: fill the form and wait for the operator to click Post' })
  @IsOptional()
  @IsBoolean()
  autoSubmit?: boolean;
}
