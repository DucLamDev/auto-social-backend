import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUrl, Max, MaxLength, Min, MinLength, ValidateNested,
} from 'class-validator';

export const UI_HINT_FIELDS = ['title', 'body', 'submit', 'opener'] as const;
export type UiHintField = (typeof UI_HINT_FIELDS)[number];
// image / text: avatars and names in the page header, collected only for sign-in hints.
export const UI_CANDIDATE_KINDS = ['input', 'textarea', 'contenteditable', 'textbox', 'button', 'submit', 'link', 'image', 'text'] as const;
/** Where an element sits; sign-in hints use it to keep feed posts out of the account check. */
export const UI_CANDIDATE_REGIONS = ['header', 'nav', 'aside', 'menu', 'main'] as const;
export type UiCandidateRegion = (typeof UI_CANDIDATE_REGIONS)[number];
export type UiCandidateKind = (typeof UI_CANDIDATE_KINDS)[number];
export const MAX_UI_CANDIDATES = 60;

/** One visible element as described by the extension: no values, no page text beyond short labels. */
export class UiCandidateDto {
  @ApiProperty() @IsInt() @Min(0) @Max(MAX_UI_CANDIDATES - 1) index!: number;
  @ApiProperty({ enum: UI_CANDIDATE_KINDS }) @IsIn(UI_CANDIDATE_KINDS) kind!: UiCandidateKind;
  @ApiProperty() @IsString() @MaxLength(20) tag!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(30) type?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(30) role?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(120) label?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(120) placeholder?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(120) text?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(120) name?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(120) id?: string;
  @ApiProperty() @IsBoolean() inDialog!: boolean;
  @ApiProperty() @IsBoolean() inForm!: boolean;
  @ApiProperty() @IsBoolean() disabled!: boolean;
  @ApiPropertyOptional({ enum: UI_CANDIDATE_REGIONS }) @IsOptional() @IsIn(UI_CANDIDATE_REGIONS) region?: UiCandidateRegion;
  @ApiPropertyOptional({ description: 'Inside a post, comment or feed item' }) @IsOptional() @IsBoolean() inArticle?: boolean;
  @ApiProperty({ description: 'Unique CSS path of the element in its document or shadow root' })
  @IsString() @MinLength(1) @MaxLength(300) selector!: string;
}

export class UiHintRequestDto {
  @ApiProperty({ enum: UI_HINT_FIELDS, isArray: true })
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(4) @ArrayUnique() @IsIn(UI_HINT_FIELDS, { each: true })
  missing!: UiHintField[];

  @ApiProperty({ description: 'Current page URL; must be on the task destination' })
  @IsUrl({ require_protocol: true, require_tld: false, protocols: ['http', 'https'] }) @MaxLength(2048)
  url!: string;

  @ApiProperty({ type: [UiCandidateDto] })
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(MAX_UI_CANDIDATES) @ValidateNested({ each: true }) @Type(() => UiCandidateDto)
  candidates!: UiCandidateDto[];
}

/** The sign-in page the extension could not read, described like a composer (no values, masked labels). */
export class AuthHintRequestDto {
  @ApiProperty({ description: 'Current page URL; must be on the account sign-in origins' })
  @IsUrl({ require_protocol: true, require_tld: false, protocols: ['http', 'https'] }) @MaxLength(2048)
  url!: string;

  @ApiProperty({ type: [UiCandidateDto] })
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(MAX_UI_CANDIDATES) @ValidateNested({ each: true }) @Type(() => UiCandidateDto)
  candidates!: UiCandidateDto[];
}

/** The AI-located account element the extension checked against the configured username itself. */
export class AuthHintConfirmDto {
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(300)
  selector!: string;
}

export class ListSelectorSuggestionsQueryDto {
  @ApiPropertyOptional({ enum: ['PENDING', 'APPROVED', 'REJECTED'] }) @IsOptional() @IsIn(['PENDING', 'APPROVED', 'REJECTED'])
  status?: 'PENDING' | 'APPROVED' | 'REJECTED';

  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(40)
  engine?: string;
}
