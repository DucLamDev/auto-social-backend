import { Type, applyDecorators } from '@nestjs/common';
import { ApiCreatedResponse, ApiExtraModels, ApiOkResponse, ApiProperty, ApiPropertyOptional, getSchemaPath } from '@nestjs/swagger';
import {
  AccountStatus,
  CampaignStatus,
  ContentStatus,
  PlatformAvailability,
  PlatformMode,
  PublishJobStatus,
  RoleName,
  SourceArticleStatus,
  SourceType,
  VariantStatus,
} from '@prisma/client';

export class ApiMetaContractDto {
  @ApiProperty() requestId!: string;
  @ApiProperty({ format: 'date-time' }) timestamp!: string;
  @ApiPropertyOptional({ minimum: 1 }) page?: number;
  @ApiPropertyOptional({ minimum: 1 }) limit?: number;
  @ApiPropertyOptional({ minimum: 0 }) total?: number;
  @ApiPropertyOptional({ minimum: 0 }) totalPages?: number;
}

export class UserContractDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'email' }) email!: string;
  @ApiProperty() displayName!: string;
  @ApiProperty({ enum: RoleName, isArray: true }) roles!: RoleName[];
}

export class AuthSessionContractDto {
  @ApiProperty() accessToken!: string;
  @ApiProperty({ type: UserContractDto }) user!: UserContractDto;
}

export class PlatformCapabilityContractDto {
  @ApiProperty() text!: boolean;
  @ApiProperty() image!: boolean;
  @ApiProperty() video!: boolean;
  @ApiProperty() article!: boolean;
  @ApiProperty() delete!: boolean;
  @ApiProperty() schedule!: boolean;
  @ApiProperty() analytics!: boolean;
  @ApiPropertyOptional({ type: Number, nullable: true }) maxText?: number | null;
  @ApiPropertyOptional({ type: Number, nullable: true }) maxImages?: number | null;
  @ApiPropertyOptional({ type: 'object', additionalProperties: true }) metadata?: Record<string, unknown>;
}

export class PlatformSummaryContractDto {
  @ApiProperty() slug!: string;
  @ApiProperty() name!: string;
  @ApiProperty() connectorKey!: string;
  @ApiProperty() groupKey!: string;
  @ApiProperty({ type: 'object', additionalProperties: true }) defaultSettings!: Record<string, unknown>;
  @ApiProperty({ enum: PlatformMode }) mode!: PlatformMode;
  @ApiProperty({ enum: PlatformAvailability }) availability!: PlatformAvailability;
  @ApiPropertyOptional({ type: PlatformCapabilityContractDto }) capability?: PlatformCapabilityContractDto;
}

export class PlatformNameContractDto {
  @ApiProperty() slug!: string;
  @ApiProperty() name!: string;
}

export class PlatformContractDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() slug!: string;
  @ApiProperty() name!: string;
  @ApiProperty() connectorKey!: string;
  @ApiProperty() groupKey!: string;
  @ApiProperty({ type: 'object', additionalProperties: true }) defaultSettings!: Record<string, unknown>;
  @ApiProperty({ enum: PlatformMode }) mode!: PlatformMode;
  @ApiProperty({ enum: PlatformAvailability }) availability!: PlatformAvailability;
  @ApiPropertyOptional({ type: String, format: 'uri', nullable: true }) docsUrl?: string | null;
  @ApiProperty() enabled!: boolean;
  @ApiPropertyOptional({ type: PlatformCapabilityContractDto, nullable: true }) capability?: PlatformCapabilityContractDto | null;
  @ApiPropertyOptional({ type: 'object', properties: { accounts: { type: 'integer', minimum: 0 } } }) _count?: { accounts: number };
  @ApiPropertyOptional({ format: 'date-time' }) createdAt?: string;
  @ApiPropertyOptional({ format: 'date-time' }) updatedAt?: string;
}

export class CredentialSummaryContractDto {
  @ApiProperty() status!: string;
  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true }) expiresAt?: string | null;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
}

export class OAuthTokenSummaryContractDto {
  @ApiProperty({ type: [String] }) scopes!: string[];
  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true }) expiresAt?: string | null;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
}

export class PlatformAccountContractDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) platformId!: string;
  @ApiProperty() name!: string;
  @ApiPropertyOptional({ type: String, nullable: true }) username?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) externalId?: string | null;
  @ApiProperty() enabled!: boolean;
  @ApiProperty({ enum: AccountStatus }) status!: AccountStatus;
  @ApiProperty({ type: PlatformSummaryContractDto }) platform!: PlatformSummaryContractDto;
  @ApiPropertyOptional({ type: 'object', additionalProperties: true }) settings?: Record<string, unknown>;
  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true }) lastTestedAt?: string | null;
  @ApiPropertyOptional({ type: CredentialSummaryContractDto, nullable: true }) credential?: CredentialSummaryContractDto | null;
  @ApiPropertyOptional({ type: OAuthTokenSummaryContractDto, nullable: true }) oauthToken?: OAuthTokenSummaryContractDto | null;
  @ApiPropertyOptional({
    description: 'True only when an encrypted Playwright storage state is configured; the state itself is never returned.',
  })
  browserSessionConfigured?: boolean;
  @ApiPropertyOptional({ format: 'date-time' }) createdAt?: string;
  @ApiPropertyOptional({ format: 'date-time' }) updatedAt?: string;
}

export class ContentSourceContractDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ enum: SourceType }) type!: SourceType;
  @ApiPropertyOptional({ type: String, format: 'uri', nullable: true }) url?: string | null;
  @ApiProperty() enabled!: boolean;
  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true }) lastFetchedAt?: string | null;
  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true }) nextFetchAt?: string | null;
  @ApiPropertyOptional({ type: 'object', properties: { articles: { type: 'integer', minimum: 0 } } }) _count?: { articles: number };
  @ApiPropertyOptional({ format: 'date-time' }) createdAt?: string;
  @ApiPropertyOptional({ format: 'date-time' }) updatedAt?: string;
}

export class SourceSummaryContractDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ enum: SourceType }) type!: SourceType;
}

export class SourceArticleContractDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) sourceId!: string;
  @ApiProperty() title!: string;
  @ApiPropertyOptional({ type: String, nullable: true }) description?: string | null;
  @ApiPropertyOptional({ type: String, format: 'uri', nullable: true }) canonicalUrl?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) author?: string | null;
  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true }) publishedAt?: string | null;
  @ApiProperty({ type: [String] }) images!: string[];
  @ApiProperty({ type: [String] }) tags!: string[];
  @ApiProperty({ type: [String] }) categories!: string[];
  @ApiProperty({ enum: SourceArticleStatus }) status!: SourceArticleStatus;
  @ApiPropertyOptional({ type: String, nullable: true }) errorMessage?: string | null;
  @ApiProperty({ type: SourceSummaryContractDto }) source!: SourceSummaryContractDto;
  @ApiPropertyOptional({ type: 'object', nullable: true, properties: { id: { type: 'string', format: 'uuid' }, status: { enum: Object.values(ContentStatus) } } }) content?: Record<string, unknown> | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
}

export class ContentSourceLinkContractDto {
  @ApiProperty({ type: SourceSummaryContractDto }) source!: SourceSummaryContractDto;
}

export class ContentContractDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() title!: string;
  @ApiProperty() body!: string;
  @ApiPropertyOptional({ type: String, nullable: true }) summary?: string | null;
  @ApiProperty() language!: string;
  @ApiPropertyOptional({ type: String, format: 'uri', nullable: true }) canonicalUrl?: string | null;
  @ApiProperty({ enum: ContentStatus }) status!: ContentStatus;
  @ApiPropertyOptional({ type: ContentSourceLinkContractDto, nullable: true }) sourceArticle?: ContentSourceLinkContractDto | null;
  @ApiPropertyOptional({ type: 'object', properties: { variants: { type: 'integer', minimum: 0 }, campaigns: { type: 'integer', minimum: 0 } } }) _count?: { variants: number; campaigns: number };
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
}

export class ContentVariantContractDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) contentId!: string;
  @ApiProperty({ format: 'uuid' }) platformId!: string;
  @ApiPropertyOptional({ type: String, nullable: true }) title?: string | null;
  @ApiProperty() body!: string;
  @ApiProperty({ type: [String] }) hashtags!: string[];
  @ApiPropertyOptional({ type: String, nullable: true }) summary?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) cta?: string | null;
  @ApiProperty() recommended!: boolean;
  @ApiPropertyOptional({ type: String, nullable: true }) reason?: string | null;
  @ApiPropertyOptional({ type: 'object', additionalProperties: true, nullable: true }) mediaRecommendation?: Record<string, unknown> | null;
  @ApiProperty({ enum: VariantStatus }) status!: VariantStatus;
  @ApiProperty() version!: number;
  @ApiPropertyOptional({ type: PlatformNameContractDto }) platform?: PlatformNameContractDto;
  @ApiPropertyOptional({ type: 'object', additionalProperties: true }) content?: Record<string, unknown>;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
}

export class CampaignProgressContractDto {
  @ApiProperty() total!: number;
  @ApiProperty() published!: number;
  @ApiProperty() failed!: number;
  @ApiProperty() needsAction!: number;
  @ApiProperty() active!: number;
  @ApiProperty() scheduled!: number;
  @ApiProperty() cancelled!: number;
}

export class CampaignContractDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ format: 'uuid' }) contentId!: string;
  @ApiProperty({ enum: CampaignStatus }) status!: CampaignStatus;
  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true }) scheduledAt?: string | null;
  @ApiProperty() timezone!: string;
  @ApiPropertyOptional({ type: CampaignProgressContractDto }) progress?: CampaignProgressContractDto;
  @ApiPropertyOptional({ type: 'object', additionalProperties: true }) content?: Record<string, unknown>;
  @ApiPropertyOptional({ type: 'array', items: { type: 'object', additionalProperties: true } }) targets?: Array<Record<string, unknown>>;
  @ApiPropertyOptional({ type: 'object', properties: { targets: { type: 'integer', minimum: 0 } } }) _count?: { targets: number };
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
}

export class AutomatedCampaignContractDto {
  @ApiProperty({ type: CampaignContractDto }) campaign!: CampaignContractDto;
  @ApiProperty({ type: ContentContractDto }) content!: ContentContractDto;
  @ApiProperty({ minimum: 1 }) generatedVariants!: number;
  @ApiProperty({ minimum: 1 }) jobsCreated!: number;
  @ApiProperty({ description: 'Whether the campaign was activated for immediate or scheduled delivery.' }) activated!: boolean;
}

export class AiProviderContractDto {
  @ApiProperty({ enum: ['openai', 'deepseek', 'gemini'] }) id!: string;
  @ApiProperty() label!: string;
  @ApiProperty() model!: string;
  @ApiProperty() configured!: boolean;
  @ApiProperty() isDefault!: boolean;
}

export class PublishJobContractDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: PublishJobStatus }) status!: PublishJobStatus;
  @ApiProperty({ format: 'uuid' }) platformAccountId!: string;
  @ApiProperty({ format: 'date-time' }) scheduledAt!: string;
  @ApiProperty() attemptCount!: number;
  @ApiProperty() maxAttempts!: number;
  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true }) nextAttemptAt?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) lastErrorCode?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) lastErrorMessage?: string | null;
  @ApiPropertyOptional({ type: 'object', additionalProperties: true }) platformAccount?: Record<string, unknown>;
  @ApiPropertyOptional({ type: 'object', additionalProperties: true }) target?: Record<string, unknown>;
  @ApiPropertyOptional({ type: 'object', additionalProperties: true, nullable: true }) publishedPost?: Record<string, unknown> | null;
  @ApiPropertyOptional({ type: 'array', items: { type: 'object', additionalProperties: true } }) attempts?: Array<Record<string, unknown>>;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
}

export class PublishJobMetricsContractDto {
  @ApiProperty({ minimum: 0 }) publishedToday!: number;
  @ApiProperty({ minimum: 0 }) scheduled!: number;
  @ApiProperty({ minimum: 0 }) processing!: number;
  @ApiProperty({ minimum: 0 }) failed!: number;
}

export class ManualPayloadContractDto {
  @ApiProperty({ format: 'uuid' }) jobId!: string;
  @ApiProperty({ enum: PublishJobStatus }) status!: PublishJobStatus;
  @ApiProperty() platform!: string;
  @ApiProperty() accountName!: string;
  @ApiPropertyOptional({ type: String, nullable: true }) title?: string | null;
  @ApiProperty() body!: string;
  @ApiPropertyOptional({ type: String, nullable: true }) summary?: string | null;
  @ApiProperty({ type: [String] }) hashtags!: string[];
  @ApiPropertyOptional({ type: String, nullable: true }) cta?: string | null;
  @ApiPropertyOptional({ type: String, format: 'uri', nullable: true }) canonicalUrl?: string | null;
  @ApiProperty({
    type: 'array',
    items: {
      type: 'object',
      required: ['type', 'url'],
      properties: {
        type: { type: 'string', enum: ['image', 'video', 'document'] },
        url: { type: 'string', format: 'uri' },
        altText: { type: 'string' },
        mimeType: { type: 'string' },
      },
    },
  })
  media!: Array<{ type: string; url: string; altText?: string; mimeType?: string }>;
  @ApiPropertyOptional() suggestedExternalPostId?: string;
  @ApiPropertyOptional({ format: 'uri' }) openUrl?: string;
}

export class MutationResultContractDto {
  @ApiPropertyOptional() loggedOut?: boolean;
  @ApiPropertyOptional() queued?: boolean;
  @ApiPropertyOptional() published?: boolean;
}

export class ConnectionTestContractDto {
  @ApiProperty() ok!: boolean;
  @ApiPropertyOptional() accountName?: string;
  @ApiPropertyOptional() manual?: boolean;
  @ApiPropertyOptional() ready?: boolean;
  @ApiPropertyOptional() message?: string;
  @ApiPropertyOptional({ type: 'object', additionalProperties: true }) details?: Record<string, unknown>;
}

export class FetchResultContractDto {
  @ApiProperty() discovered!: number;
  @ApiProperty() inserted!: number;
  @ApiProperty() duplicates!: number;
}

export class AdminUserContractDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'email' }) email!: string;
  @ApiProperty() displayName!: string;
  @ApiProperty() enabled!: boolean;
  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true }) lastLoginAt?: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiPropertyOptional({ type: 'array', items: { type: 'object', additionalProperties: true } }) roles?: Array<Record<string, unknown>>;
}

export class ConnectorDescriptorContractDto {
  @ApiProperty() platform!: string;
  @ApiProperty({ enum: PlatformMode }) mode!: PlatformMode;
  @ApiProperty({ type: 'object', additionalProperties: true }) capability!: Record<string, unknown>;
}

export class PromptTemplateContractDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() systemPrompt!: string;
  @ApiProperty() userTemplate!: string;
  @ApiProperty({ type: 'object', additionalProperties: true }) schema!: Record<string, unknown>;
  @ApiProperty() version!: number;
  @ApiProperty() active!: boolean;
  @ApiPropertyOptional({ type: 'object', additionalProperties: true }) platform?: Record<string, unknown>;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
}

export class PublishedPostContractDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) publishJobId!: string;
  @ApiProperty({ format: 'uuid' }) platformAccountId!: string;
  @ApiProperty() externalPostId!: string;
  @ApiPropertyOptional({ type: String, format: 'uri', nullable: true }) url?: string | null;
  @ApiProperty({ format: 'date-time' }) publishedAt!: string;
  @ApiPropertyOptional({ type: 'object', additionalProperties: true }) platformAccount?: Record<string, unknown>;
  @ApiPropertyOptional({ type: 'object', additionalProperties: true }) job?: Record<string, unknown>;
}

export class MediaAssetContractDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiPropertyOptional({ type: String, format: 'uuid', nullable: true }) contentId?: string | null;
  @ApiPropertyOptional({ type: String, format: 'uuid', nullable: true }) variantId?: string | null;
  @ApiProperty({ enum: ['IMAGE', 'VIDEO', 'DOCUMENT'] }) type!: string;
  @ApiProperty() storageKey!: string;
  @ApiPropertyOptional({ type: String, format: 'uri', nullable: true }) publicUrl?: string | null;
  @ApiProperty() mimeType!: string;
  @ApiProperty({ description: 'Decimal byte count serialized as a string' }) sizeBytes!: string;
  @ApiProperty() checksum!: string;
  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description: 'Media metadata. Uploaded accessible descriptions are returned as altText.',
    example: { altText: 'A dashboard showing campaign performance.' },
  })
  metadata!: Record<string, unknown>;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
}

export class PublishAttemptLogContractDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() attemptNumber!: number;
  @ApiProperty() status!: string;
  @ApiPropertyOptional({ type: String, nullable: true }) errorCode?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) errorMessage?: string | null;
  @ApiProperty({ format: 'date-time' }) startedAt!: string;
  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true }) finishedAt?: string | null;
  @ApiPropertyOptional({ type: 'object', additionalProperties: true, nullable: true }) responseMetadata?: Record<string, unknown> | null;
  @ApiPropertyOptional({ type: 'object', additionalProperties: true }) job?: Record<string, unknown>;
}

export class AuditLogContractDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiPropertyOptional({ type: String, format: 'uuid', nullable: true }) actorId?: string | null;
  @ApiProperty() action!: string;
  @ApiProperty() entityType!: string;
  @ApiPropertyOptional({ type: String, nullable: true }) entityId?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) requestId?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) ipAddress?: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiPropertyOptional({ type: 'object', additionalProperties: true, nullable: true }) actor?: Record<string, unknown> | null;
  @ApiPropertyOptional({ type: 'object', additionalProperties: true, nullable: true }) before?: Record<string, unknown> | null;
  @ApiPropertyOptional({ type: 'object', additionalProperties: true, nullable: true }) after?: Record<string, unknown> | null;
}

export class SystemSettingContractDto {
  @ApiProperty() key!: string;
  @ApiProperty({ type: 'object', additionalProperties: true }) value!: Record<string, unknown>;
  @ApiPropertyOptional({ type: String, nullable: true }) description?: string | null;
  @ApiProperty() secret!: boolean;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
}

export class OAuthProviderContractDto {
  @ApiProperty() provider!: string;
  @ApiPropertyOptional() platform?: string;
  @ApiProperty() status!: string;
  @ApiPropertyOptional() callback?: string;
}

export class OAuthStartContractDto {
  @ApiProperty({ format: 'uri' }) authorizationUrl!: string;
}

export class AttentionAccountContractDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ enum: ['CONNECTED', 'EXPIRED', 'RECONNECT_REQUIRED', 'DISABLED', 'ERROR'] }) status!: string;
  @ApiProperty() platform!: string;
  @ApiProperty() platformName!: string;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) expiresAt!: string | null;
  @ApiProperty({ description: 'The system renews this token without the user signing in again' }) autoRefresh!: boolean;
}

export class AttentionAccountsContractDto {
  @ApiProperty({ type: [AttentionAccountContractDto] }) problems!: AttentionAccountContractDto[];
  @ApiProperty({ type: [AttentionAccountContractDto] }) expiringSoon!: AttentionAccountContractDto[];
}

export class AttentionJobsContractDto {
  @ApiProperty() needsAction!: number;
  @ApiProperty() failed!: number;
  @ApiProperty() possibleDuplicate!: number;
  @ApiProperty() retrying!: number;
  @ApiProperty({ description: 'Posts queued for the Chrome extension (not operator work)' }) waitingExtension!: number;
}

export class AttentionExtensionContractDto {
  @ApiProperty({ description: 'Paired Chrome extensions seen in the last 3 minutes' }) devicesOnline!: number;
  @ApiProperty({ description: 'Posts are waiting but no Chrome extension is running' }) offline!: boolean;
}

export class AccountHealthContractDto {
  @ApiProperty({ description: 'Items an operator should act on' }) total!: number;
  @ApiProperty({ type: AttentionAccountsContractDto }) accounts!: AttentionAccountsContractDto;
  @ApiProperty({ type: AttentionJobsContractDto }) jobs!: AttentionJobsContractDto;
  @ApiProperty({ type: AttentionExtensionContractDto }) extension!: AttentionExtensionContractDto;
  @ApiProperty() alertsEnabled!: boolean;
  @ApiProperty({ format: 'date-time' }) generatedAt!: string;
}

export class MaintenanceRunContractDto {
  @ApiProperty({ example: { refreshed: 1, failed: 0, skipped: 2 } }) tokens!: Record<string, number>;
  @ApiProperty({ example: { checked: 3, failed: 0 } }) connections!: Record<string, number>;
}

export class HealthContractDto {
  @ApiProperty({ enum: ['ok'] }) status!: 'ok';
  @ApiProperty() service!: string;
  @ApiProperty({ format: 'date-time' }) timestamp!: string;
}

export class ReadinessContractDto {
  @ApiProperty({ enum: ['ready'] }) status!: 'ready';
  @ApiProperty({ enum: ['up'] }) database!: 'up';
  @ApiProperty({ enum: ['up', 'down'] }) redis!: 'up' | 'down';
  @ApiProperty({ enum: ['up', 'down'] }) rabbitmq!: 'up' | 'down';
  @ApiProperty({ format: 'date-time' }) timestamp!: string;
}

function envelopeSchema(model: Type<unknown>, isArray: boolean) {
  const item = { $ref: getSchemaPath(model) };
  return {
    type: 'object',
    required: ['success', 'data', 'meta'],
    properties: {
      success: { type: 'boolean', example: true },
      data: isArray ? { type: 'array', items: item } : item,
      meta: { $ref: getSchemaPath(ApiMetaContractDto) },
    },
  };
}

export function ApiOkEnvelope(model: Type<unknown>, isArray = false): MethodDecorator {
  return applyDecorators(
    ApiExtraModels(ApiMetaContractDto, model),
    ApiOkResponse({ schema: envelopeSchema(model, isArray) }),
  );
}

export function ApiCreatedEnvelope(model: Type<unknown>, isArray = false): MethodDecorator {
  return applyDecorators(
    ApiExtraModels(ApiMetaContractDto, model),
    ApiCreatedResponse({ schema: envelopeSchema(model, isArray) }),
  );
}
