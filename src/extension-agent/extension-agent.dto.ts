import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsOptional, IsString, IsUrl, IsUUID, Length, MaxLength } from 'class-validator';
import { EXTENSION_ENGINES, ExtensionEngine } from '../connectors/extension/extension-delivery';

export class ClaimExtensionTaskDto {
  @IsOptional()
  @IsIn([1])
  authProtocol?: number;
  @ApiPropertyOptional({ type: [String], description: 'Origins already running a flow in this Chrome' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsUrl({ require_protocol: true, require_tld: false, protocols: ['http', 'https'] }, { each: true })
  @MaxLength(2048, { each: true })
  excludeOrigins?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @IsIn(EXTENSION_ENGINES, { each: true })
  supportedEngines?: ExtensionEngine[];
}

export const EXTENSION_NEEDS_ACTION_REASONS = ['CAPTCHA_REQUIRED', 'WAITING_USER', 'SUBMIT_UNCONFIRMED', 'SUBMIT_REJECTED', 'MODERATION_PENDING', 'AUTH_REQUIRED', 'ACCOUNT_MISMATCH'] as const;
/** Reasons the extension reports only when nothing was submitted, so a retry cannot duplicate the post. */
export const EXTENSION_FAILED_REASONS = ['LOGIN_REQUIRED', 'EDITOR_NOT_FOUND', 'PERMISSION_REQUIRED', 'PAGE_LOAD_FAILED', 'CANCELLED', 'MEDIA_REQUIRED', 'PLATFORM_UNAVAILABLE'] as const;

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

  @ApiPropertyOptional({ enum: EXTENSION_ENGINES })
  @IsOptional()
  @IsIn(EXTENSION_ENGINES)
  engine?: ExtensionEngine;

  @ApiPropertyOptional({ example: 'https://voz.vn/f/chuyen-tro-linh-tinh.17/post-thread' })
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  targetUrl?: string;

  @ApiPropertyOptional({ description: 'false: fill the form and wait for the operator to click Post' })
  @IsOptional()
  @IsBoolean()
  autoSubmit?: boolean;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  @MaxLength(80, { each: true })
  tags?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(160)
  category?: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  flair?: string;
}

export class ExtensionSessionDto {
  @IsIn(['password', 'google'])
  provider!: 'password' | 'google';
  @IsUUID()
  deviceId!: string;

  @IsString()
  @Length(1, 200)
  expectedUsername!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2048)
  profileUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  identitySelector?: string;

  @IsBoolean()
  autoLogin!: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(2048)
  loginUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  loginUsername?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1024)
  password?: string;

  @IsBoolean()
  autoTotp!: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(2048)
  totpSecret?: string;
}

export class ExtensionAuthStepDto {
  @IsIn(['identifier', 'password', 'totp'])
  step!: 'identifier' | 'password' | 'totp';

  @IsString()
  @MaxLength(2048)
  pageUrl!: string;
}
