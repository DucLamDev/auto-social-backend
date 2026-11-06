import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { RoleName, VariantStatus } from '@prisma/client';
import { ArrayMaxSize, IsArray, IsBoolean, IsEnum, IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { AI_PROVIDER_IDS, AiProvider } from '../ai/ai-provider';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/auth.types';
import { ApiCreatedEnvelope, ApiOkEnvelope, ContentVariantContractDto } from '../common/swagger/api-contract.dto';
import { ContentVariantsService } from './content-variants.service';
import { VariantApprovalService } from './variant-approval.service';
import { VariantImageService } from './variant-image.service';
import { MAX_REWRITE_INSTRUCTION_LENGTH, MAX_REWRITE_NOTE_LENGTH, MAX_REWRITE_NOTES, VariantRewriteService } from './variant-rewrite.service';
import { CreateContentVariantDto } from './dto/create-content-variant.dto';

class UpdateVariantStatusDto {
  @ApiProperty({ enum: VariantStatus })
  @IsEnum(VariantStatus)
  status!: VariantStatus;
}

class UpdateVariantDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) title?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() body?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() summary?: string;
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsArray() @IsString({ each: true }) hashtags?: string[];
  @ApiPropertyOptional() @IsOptional() @IsString() cta?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() recommended?: boolean;
  @ApiPropertyOptional({ enum: VariantStatus }) @IsOptional() @IsEnum(VariantStatus) status?: VariantStatus;
}

class PreviewVariantDto {
  @ApiPropertyOptional({ description: 'Unsaved title to preview instead of the stored one.' }) @IsOptional() @IsString() @MaxLength(500) title?: string;
  @ApiPropertyOptional({ description: 'Unsaved body to preview instead of the stored one.' }) @IsOptional() @IsString() @MaxLength(100_000) body?: string;
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsArray() @ArrayMaxSize(30) @IsString({ each: true }) @MaxLength(80, { each: true }) hashtags?: string[];
  @ApiPropertyOptional({ description: 'Account of the same platform whose posting route decides the formatting.' }) @IsOptional() @IsUUID() platformAccountId?: string;
}

class PreviewDestinationDto {
  @ApiPropertyOptional({ description: 'Lemmy / Discuit community or Reddit subreddit (r/name) set on the account.' }) community?: string;
  @ApiPropertyOptional({ description: 'Forum category or box set on the account.' }) category?: string;
  @ApiPropertyOptional() flair?: string;
  @ApiProperty({ enum: ['vi', 'en'] }) language!: 'vi' | 'en';
}

class VariantPreviewDto {
  @ApiProperty({ description: 'Empty for destinations without a title field (short-form social, Quora).' }) title!: string;
  @ApiProperty({ description: 'Body exactly as the destination receives it; for appearance "rich" it keeps the Markdown the extension turns into HTML.' }) body!: string;
  @ApiProperty({ enum: ['plain', 'markdown', 'html'] }) format!: string;
  @ApiProperty({ enum: ['markdown', 'plain', 'rich'], description: 'How to show the body: rendered Markdown, plain paragraphs, or rich text (pasted HTML editor or HTML field).' }) appearance!: 'markdown' | 'plain' | 'rich';
  @ApiProperty({ type: [String], description: 'Tags really sent in the destination tag field (for a Chrome extension account: its own tags, then the AI tags the site accepts); empty when hashtags stay in the text.' }) tags!: string[];
  @ApiProperty({ type: PreviewDestinationDto }) destination!: PreviewDestinationDto;
  @ApiProperty({ description: 'Platform group (SOCIAL, FORUM, DEVELOPER, BLOGGING…).' }) group!: string;
  @ApiPropertyOptional({ nullable: true, type: String }) engine!: string | null;
  @ApiPropertyOptional({ nullable: true, type: Number }) maxChars!: number | null;
  @ApiProperty() length!: number;
  @ApiProperty() overLimit!: boolean;
}

class RegenerateVariantImageDto {
  @ApiPropertyOptional({ description: 'New image description; the stored one is reused when omitted, and the AI designs one from the post when there is none.', maxLength: 4000 })
  @IsOptional() @IsString() @MaxLength(4_000) prompt?: string;
}

class RewriteVariantDto {
  @ApiPropertyOptional({ description: 'What to change, in the operator\'s words; the last review notes are added automatically.', maxLength: MAX_REWRITE_INSTRUCTION_LENGTH })
  @IsOptional() @IsString() @MaxLength(MAX_REWRITE_INSTRUCTION_LENGTH) instruction?: string;

  @ApiPropertyOptional({ type: [String], maxItems: MAX_REWRITE_NOTES, description: 'Review recommendations the operator chose to apply ("Sửa theo khuyến nghị"). When sent, they replace the automatic review notes: the AI fixes only these.' })
  @IsOptional() @IsArray() @ArrayMaxSize(MAX_REWRITE_NOTES) @IsString({ each: true }) @MaxLength(MAX_REWRITE_NOTE_LENGTH, { each: true }) notes?: string[];

  @ApiPropertyOptional({ enum: AI_PROVIDER_IDS, description: 'AI provider; the default one when omitted.' })
  @IsOptional() @IsIn(AI_PROVIDER_IDS) aiProvider?: AiProvider;
}

@ApiTags('content-variants')
@ApiBearerAuth()
@Controller('content-variants')
export class ContentVariantsController {
  constructor(
    private readonly variants: ContentVariantsService,
    private readonly images: VariantImageService,
    private readonly rewrites: VariantRewriteService,
    private readonly approvals: VariantApprovalService,
  ) {}

  @Post()
  @ApiCreatedEnvelope(ContentVariantContractDto)
  @Roles(RoleName.ADMIN, RoleName.EDITOR)
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateContentVariantDto) {
    return this.variants.createManual(user.id, dto);
  }

  @Get()
  @ApiOkEnvelope(ContentVariantContractDto, true)
  list(@CurrentUser() user: AuthenticatedUser, @Query('contentId') contentId?: string) {
    return this.variants.list(user.id, contentId);
  }

  /** Read-only: renders the post the way its destination will show it. */
  @Post(':id/preview')
  @HttpCode(HttpStatus.OK)
  @ApiOkEnvelope(VariantPreviewDto)
  preview(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: PreviewVariantDto) {
    return this.variants.preview(user.id, id, dto);
  }

  @Patch(':id')
  @ApiOkEnvelope(ContentVariantContractDto)
  @Roles(RoleName.ADMIN, RoleName.EDITOR)
  update(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateVariantDto) {
    return this.variants.updateUnreferenced(user.id, id, dto);
  }

  @Patch(':id/status')
  @ApiOkEnvelope(ContentVariantContractDto)
  @Roles(RoleName.ADMIN, RoleName.EDITOR)
  updateStatus(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateVariantStatusDto) {
    return this.variants.updateUnreferenced(user.id, id, { status: dto.status });
  }

  /** Starts a new AI image for a draft variant; the review screen follows its status. */
  @Post(':id/image')
  @HttpCode(HttpStatus.ACCEPTED)
  @Roles(RoleName.ADMIN, RoleName.EDITOR)
  regenerateImage(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: RegenerateVariantImageDto) {
    return this.images.regenerate(user.id, id, dto);
  }

  /** Starts an AI rewrite of a draft variant; the review screen follows `aiRevision.status`. */
  @Post(':id/rewrite')
  @HttpCode(HttpStatus.ACCEPTED)
  @Roles(RoleName.ADMIN, RoleName.EDITOR)
  rewrite(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: RewriteVariantDto) {
    return this.rewrites.start(user.id, id, dto);
  }

  /** Runs the final AI approver again on a draft's current text; the review screen follows `aiApproval.status`. */
  @Post(':id/ai-approval')
  @HttpCode(HttpStatus.ACCEPTED)
  @Roles(RoleName.ADMIN, RoleName.EDITOR)
  requestAiApproval(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.approvals.start(user.id, id);
  }

  @Delete(':id/image/:mediaId')
  @Roles(RoleName.ADMIN, RoleName.EDITOR)
  removeImage(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string, @Param('mediaId', ParseUUIDPipe) mediaId: string) {
    return this.images.remove(user.id, id, mediaId);
  }
}
