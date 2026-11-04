import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUrl, Max, MaxLength, Min, MinLength, ValidateNested,
} from 'class-validator';

export const FORM_CONTROL_KINDS = ['select', 'checkbox', 'radio', 'combobox', 'text'] as const;
export type FormControlKind = (typeof FORM_CONTROL_KINDS)[number];
export const FORM_ACTIONS = ['select', 'check', 'uncheck', 'type'] as const;
export type FormActionKind = (typeof FORM_ACTIONS)[number];
export const MAX_FORM_CONTROLS = 60;
export const MAX_FORM_OPTIONS = 40;
export const MAX_FORM_TEXT = 200;

export class FormOptionDto {
  @ApiProperty() @IsString() @MaxLength(120) value!: string;
  @ApiProperty() @IsString() @MaxLength(120) label!: string;
}

/** One control of the post form as the extension sees it: no typed values, only option lists and states. */
export class FormControlDto {
  @ApiProperty() @IsInt() @Min(0) @Max(MAX_FORM_CONTROLS - 1) index!: number;
  @ApiProperty({ enum: FORM_CONTROL_KINDS }) @IsIn(FORM_CONTROL_KINDS) kind!: FormControlKind;
  @ApiProperty() @IsString() @MaxLength(20) tag!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(30) type?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(120) label?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(120) name?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(120) id?: string;
  @ApiProperty() @IsBoolean() required!: boolean;
  @ApiProperty({ description: 'The page marks the control invalid (aria-invalid, :invalid)' }) @IsBoolean() invalid!: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() checked?: boolean;
  @ApiPropertyOptional({ description: 'Label of the option currently chosen' }) @IsOptional() @IsString() @MaxLength(120) selected?: string;
  @ApiPropertyOptional({ type: [FormOptionDto] })
  @IsOptional() @IsArray() @ArrayMaxSize(MAX_FORM_OPTIONS) @ValidateNested({ each: true }) @Type(() => FormOptionDto)
  options?: FormOptionDto[];
  @ApiProperty({ description: 'Unique CSS path of the control in its document or shadow root' })
  @IsString() @MinLength(1) @MaxLength(300) selector!: string;
}

export class FormFillRequestDto {
  @ApiProperty({ description: 'Current page URL; must be on the task destination' })
  @IsUrl({ require_protocol: true, require_tld: false, protocols: ['http', 'https'] }) @MaxLength(2048)
  url!: string;

  @ApiProperty({ type: [FormControlDto] })
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(MAX_FORM_CONTROLS) @ValidateNested({ each: true }) @Type(() => FormControlDto)
  controls!: FormControlDto[];
}

/** What the extension may do: one action per control, checked by the backend against the controls it sent. */
export class FormActionDto {
  @ApiProperty() index!: number;
  @ApiProperty() selector!: string;
  @ApiProperty({ enum: FORM_ACTIONS }) action!: FormActionKind;
  @ApiPropertyOptional({ description: 'Option value for select; text for type' }) value?: string;
}
