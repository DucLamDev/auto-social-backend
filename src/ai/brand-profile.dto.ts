import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsObject } from 'class-validator';

// Documentation only: the profile is checked by BrandProfileContentSchema (zod),
// the same schema the AI applies when it loads the profile.

export class BrandProfileLinkDto {
  @ApiProperty({ maxLength: 80 }) label!: string;
  @ApiProperty({ maxLength: 500, description: 'http(s) only' }) url!: string;
}

/** What the settings form edits. */
export class BrandProfileContentDto {
  @ApiPropertyOptional({ maxLength: 120 }) brandName?: string;
  @ApiPropertyOptional({ maxLength: 300 }) oneLiner?: string;
  @ApiPropertyOptional({ maxLength: 500 }) audience?: string;
  @ApiPropertyOptional({ maxLength: 500 }) voice?: string;
  @ApiPropertyOptional({ type: [String], maxItems: 30, description: 'Each at most 300 characters' }) facts?: string[];
  @ApiPropertyOptional({ type: [BrandProfileLinkDto], maxItems: 10 }) links?: BrandProfileLinkDto[];
  @ApiPropertyOptional({ maxLength: 200 }) disclosure?: string;
  @ApiPropertyOptional({ type: [String], maxItems: 20, description: 'Each at most 200 characters' }) avoid?: string[];
}

/** The saved profile, with the reading languages set in the general settings. */
export class BrandProfileDto extends BrandProfileContentDto {
  @ApiPropertyOptional({ enum: ['vi', 'en'] }) defaultLanguage?: 'vi' | 'en';
  @ApiPropertyOptional({ type: 'object', additionalProperties: { type: 'string', enum: ['vi', 'en'] } }) platformLanguages?: Record<string, 'vi' | 'en'>;
}

export class BrandProfileViewDto {
  @ApiProperty({ type: BrandProfileDto, nullable: true, description: 'The profile the AI writes with; null when none is saved or it is ignored' })
  profile!: BrandProfileDto | null;
  @ApiProperty({ description: 'A profile is saved but the AI ignores it (invalid, over 8 KB or stored as a secret)' }) invalid!: boolean;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) updatedAt!: string | null;
  @ApiProperty({ type: BrandProfileContentDto, description: 'Where the form starts when nothing is saved' }) suggested!: BrandProfileContentDto;
}

export class UpdateBrandProfileDto {
  @ApiProperty({ type: BrandProfileContentDto }) @IsObject() profile!: Record<string, unknown>;
}
