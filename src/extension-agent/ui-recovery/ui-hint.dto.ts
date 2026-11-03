import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUrl, Max, MaxLength, Min, MinLength, ValidateNested,
} from 'class-validator';

export const UI_HINT_FIELDS = ['title', 'body', 'submit', 'opener'] as const;
export type UiHintField = (typeof UI_HINT_FIELDS)[number];
export const UI_CANDIDATE_KINDS = ['input', 'textarea', 'contenteditable', 'textbox', 'button', 'submit', 'link'] as const;
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

export class ListSelectorSuggestionsQueryDto {
  @ApiPropertyOptional({ enum: ['PENDING', 'APPROVED', 'REJECTED'] }) @IsOptional() @IsIn(['PENDING', 'APPROVED', 'REJECTED'])
  status?: 'PENDING' | 'APPROVED' | 'REJECTED';

  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(40)
  engine?: string;
}
