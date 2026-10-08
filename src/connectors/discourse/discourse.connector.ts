import { Injectable } from '@nestjs/common';
import { PlatformMode } from '@prisma/client';
import { ErrorCode } from '../../common/exceptions/application.exception';
import { sha256 } from '../../common/utils/crypto.utils';
import { ConnectorError } from '../core/connector-error';
import { HttpConnectorBase } from '../core/http-connector.base';
import {
  ConnectionTestResult,
  ConnectorAccount,
  PostPayload,
  PublishResult,
} from '../core/connector.types';
import { SocialPublisher } from '../core/social-publisher.interface';

interface DiscoursePost {
  hidden?: boolean;
  id?: number | string;
  post_number?: number;
  reviewable_id?: number | string;
  topic_id?: number | string;
  topic_slug?: string;
}

interface DiscourseCreateTopicResponse extends DiscoursePost {
  action?: string;
  pending_post?: {
    id?: number | string;
  };
  success?: boolean;
  post?: DiscoursePost;
}

interface DiscourseCurrentUserResponse {
  current_user?: {
    can_create_topic?: boolean;
    name?: string;
    username?: string;
  };
}

interface DiscourseCategoryResponse {
  category?: {
    id?: number | string;
    minimum_required_tags?: unknown;
    name?: string;
    permission?: number | string;
    required_tag_groups?: unknown;
    slug?: string;
  };
}

interface DiscourseTagRequirement {
  minCount: number;
  name?: string;
}

interface DiscourseTopicResponse {
  category_id?: number | string;
  id?: number | string;
  post_stream?: {
    posts?: DiscoursePost[];
  };
  slug?: string;
  visible?: boolean;
}

interface DiscourseConfiguration {
  apiKey: string;
  apiUsername: string;
  baseUrl: string;
  categoryId: number;
}

const EXTERNAL_ID_HASH_LENGTH = 47;

@Injectable()
export class DiscourseConnector extends HttpConnectorBase implements SocialPublisher {
  readonly platform = 'discourse';
  readonly mode = PlatformMode.COMPATIBLE_API;
  readonly capability = {
    text: true,
    image: false,
    video: false,
    article: true,
    delete: false,
    schedule: false,
    analytics: false,
  };

  validate(post: PostPayload): Promise<void> {
    if (!post.title?.trim() || !post.body.trim()) {
      throw new ConnectorError(
        ErrorCode.PLATFORM_CONTENT_REJECTED,
        'Discourse topic title and body are required',
        false,
      );
    }
    if (post.media?.length) {
      throw new ConnectorError(
        ErrorCode.PLATFORM_MEDIA_INVALID,
        'Media upload is outside the Discourse connector scope',
        false,
      );
    }
    return Promise.resolve();
  }

  async publish(account: ConnectorAccount, post: PostPayload): Promise<PublishResult> {
    await this.validate(post);
    const configuration = this.configuration(account);
    const providerExternalId = this.providerExternalId(post.idempotencyKey);
    const tags = this.topicTags(account.settings.defaultTags);
    try {
      const { data: rawData } = await this.requestDynamic<unknown>(
        `${configuration.baseUrl}/posts.json`,
        {
          method: 'POST',
          headers: this.headers(configuration, true),
          body: JSON.stringify({
            title: post.title!.trim(),
            raw: post.body,
            category: configuration.categoryId,
            external_id: providerExternalId,
            ...(tags.length ? { tags } : {}),
          }),
        },
      );
      const data = this.objectResponse<DiscourseCreateTopicResponse>(
        rawData,
        'Discourse returned an invalid create-topic response; verify the forum before retrying',
      );

      if (data.success === false) {
        throw new ConnectorError(
          ErrorCode.PLATFORM_CONTENT_REJECTED,
          'Discourse rejected the topic',
          false,
        );
      }
      return this.createdTopicResult(configuration, providerExternalId, data);
    } catch (error) {
      let recovered: PublishResult | undefined;
      try {
        recovered = await this.recoverByExternalId(
          configuration,
          providerExternalId,
          error,
        );
      } catch (lookupError) {
        if (this.isUncertainCreateFailure(error)) {
          return this.unreconciledCreateResult(providerExternalId, error, lookupError);
        }
        throw lookupError;
      }
      if (recovered) return recovered;
      if (this.isUncertainCreateFailure(error)) {
        return this.unreconciledCreateResult(providerExternalId, error);
      }
      throw error;
    }
  }

  private createdTopicResult(
    configuration: DiscourseConfiguration,
    providerExternalId: string,
    data: DiscourseCreateTopicResponse,
  ): PublishResult {
    const createdPost = data.post ?? data;
    const topicId = this.positiveInteger(createdPost.topic_id);
    const postId = this.positiveInteger(createdPost.id);
    const reviewableId = this.positiveInteger(createdPost.reviewable_id);
    const pendingPostId = this.positiveInteger(data.pending_post?.id);
    const topicUrl = topicId === undefined
      ? undefined
      : this.topicUrl(configuration.baseUrl, topicId, createdPost.topic_slug);
    if (
      data.action === 'enqueued'
      || reviewableId !== undefined
      || pendingPostId !== undefined
      || createdPost.hidden === true
    ) {
      return {
        externalId: topicId === undefined
          ? `pending:${providerExternalId}`
          : String(topicId),
        url: topicUrl,
        status: 'NEEDS_ACTION',
        metadata: {
          moderationQueue: true,
          providerExternalId,
          ...(data.action ? { action: data.action } : {}),
          ...(reviewableId === undefined ? {} : { reviewableId }),
          ...(pendingPostId === undefined ? {} : { pendingPostId }),
          ...(topicId === undefined ? {} : { externalPostId: String(topicId) }),
          ...(topicUrl ? { url: topicUrl } : {}),
        },
      };
    }
    if (topicId === undefined) {
      // Never automatically retry an ambiguous 2xx response: the topic may have
      // been created and a retry could publish it twice.
      throw new ConnectorError(
        ErrorCode.PLATFORM_API_ERROR,
        'Discourse returned an incomplete create-topic response; verify the forum before retrying',
        false,
      );
    }

    return {
      externalId: String(topicId),
      url: topicUrl,
      status: 'PUBLISHED',
      metadata: {
        categoryId: configuration.categoryId,
        providerExternalId,
        ...(postId === undefined ? {} : { postId }),
        ...(createdPost.post_number === undefined
          ? {}
          : { postNumber: createdPost.post_number }),
      },
    };
  }

  async testConnection(account: ConnectorAccount): Promise<ConnectionTestResult> {
    const configuration = this.configuration(account);
    const defaultTags = this.topicTags(account.settings.defaultTags);
    const requestHeaders = this.headers(configuration);
    const { data: rawSession } = await this.requestDynamic<unknown>(
      `${configuration.baseUrl}/session/current.json`,
      { headers: requestHeaders },
    );
    const session = this.objectResponse<DiscourseCurrentUserResponse>(
      rawSession,
      'Discourse returned an invalid current-user response',
    );
    const currentUsername = session.current_user?.username?.trim();
    if (!currentUsername) {
      throw new ConnectorError(
        ErrorCode.PLATFORM_AUTH_FAILED,
        'Discourse did not return an authenticated current user',
        false,
      );
    }
    if (currentUsername.toLowerCase() !== configuration.apiUsername.toLowerCase()) {
      throw new ConnectorError(
        ErrorCode.PLATFORM_AUTH_FAILED,
        'Discourse authenticated a different user than the configured API username',
        false,
      );
    }
    if (session.current_user?.can_create_topic !== true) {
      throw new ConnectorError(
        ErrorCode.PLATFORM_PERMISSION_DENIED,
        'Discourse user is not allowed to create topics',
        false,
      );
    }
    const { data: rawCategoryResponse } = await this.requestDynamic<unknown>(
      `${configuration.baseUrl}/c/${configuration.categoryId}/show.json`,
      { headers: requestHeaders },
    );
    const categoryResponse = this.objectResponse<DiscourseCategoryResponse>(
      rawCategoryResponse,
      'Discourse returned an invalid category response',
    );
    const category = categoryResponse.category;
    if (!category || this.positiveInteger(category.id) !== configuration.categoryId) {
      throw new ConnectorError(
        ErrorCode.PLATFORM_AUTH_FAILED,
        'Discourse did not return the configured category',
        false,
      );
    }
    if (this.positiveInteger(category.permission) !== 1) {
      throw new ConnectorError(
        ErrorCode.PLATFORM_PERMISSION_DENIED,
        'Discourse user cannot create topics in the configured category',
        false,
      );
    }
    const tagRequirements = this.tagRequirements(category);
    const tagPolicyRequiresStagingVerification = defaultTags.length > 0
      || tagRequirements.minimumRequiredTags > 0
      || tagRequirements.requiredTagGroups.length > 0;
    const configuredTagCountBelowReportedLowerBound = defaultTags.length
      < tagRequirements.reportedTagCountLowerBound;
    return {
      ok: true,
      accountName: currentUsername,
      details: {
        baseUrl: configuration.baseUrl,
        categoryId: configuration.categoryId,
        ...(session.current_user?.name ? { displayName: session.current_user.name } : {}),
        ...(category.name ? { categoryName: category.name } : {}),
        ...(category.slug ? { categorySlug: category.slug } : {}),
        categoryPermission: 1,
        canCreateTopic: true,
        configuredDefaultTagCount: defaultTags.length,
        minimumRequiredTags: tagRequirements.minimumRequiredTags,
        requiredTagGroups: tagRequirements.requiredTagGroups,
        reportedTagCountLowerBound: tagRequirements.reportedTagCountLowerBound,
        tagPolicyRequiresStagingVerification,
        configuredTagCountBelowReportedLowerBound,
      },
    };
  }

  private configuration(account: ConnectorAccount): DiscourseConfiguration {
    const baseUrl = this.discourseBaseUrl(
      this.requiredString(account.settings, 'baseUrl'),
    );
    const apiUsername = this.requiredString(account.settings, 'apiUsername').trim();
    const apiKey = this.requiredString(account.credentials, 'apiKey').trim();
    const categoryId = this.positiveInteger(account.settings.categoryId);
    if (categoryId === undefined) {
      throw new ConnectorError(
        ErrorCode.PLATFORM_AUTH_FAILED,
        "Connector configuration 'categoryId' must be a positive integer",
        false,
      );
    }
    return { baseUrl, apiUsername, apiKey, categoryId };
  }

  private discourseBaseUrl(value: string): string {
    const candidate = value.trim();
    // WHATWG URL normalizes an empty trailing `?`/`#` to empty search/hash,
    // but leaving the delimiter in the base would redirect appended API paths.
    if (candidate.includes('?') || candidate.includes('#')) {
      throw new ConnectorError(
        ErrorCode.PLATFORM_AUTH_FAILED,
        'Discourse base URL must not contain a query string or fragment',
        false,
      );
    }
    const baseUrl = this.normalizeBaseUrl(candidate);
    const parsed = new URL(baseUrl);
    if (parsed.search || parsed.hash) {
      throw new ConnectorError(
        ErrorCode.PLATFORM_AUTH_FAILED,
        'Discourse base URL must not contain a query string or fragment',
        false,
      );
    }
    return baseUrl;
  }

  private headers(
    configuration: DiscourseConfiguration,
    includeContentType = false,
  ): Record<string, string> {
    return {
      accept: 'application/json',
      'Api-Key': configuration.apiKey,
      'Api-Username': configuration.apiUsername,
      'user-agent': 'SocialPublisher/0.1',
      ...(includeContentType ? { 'content-type': 'application/json' } : {}),
    };
  }

  private async recoverByExternalId(
    configuration: DiscourseConfiguration,
    providerExternalId: string,
    originalError: unknown,
  ): Promise<PublishResult | undefined> {
    if (!(originalError instanceof ConnectorError)
      || ![
        ErrorCode.PLATFORM_CONTENT_REJECTED,
        ErrorCode.PLATFORM_API_ERROR,
        ErrorCode.PUBLISH_TIMEOUT,
      ].includes(originalError.code)) {
      return undefined;
    }

    try {
      const { data: rawData } = await this.requestDynamic<unknown>(
        `${configuration.baseUrl}/t/external_id/${encodeURIComponent(providerExternalId)}.json`,
        { headers: this.headers(configuration) },
      );
      const data = this.objectResponse<DiscourseTopicResponse>(
        rawData,
        'Discourse returned an invalid external-ID lookup response',
      );
      const topicId = this.positiveInteger(data.id);
      const categoryId = this.positiveInteger(data.category_id);
      if (topicId === undefined || categoryId === undefined) {
        throw new ConnectorError(
          ErrorCode.PLATFORM_API_ERROR,
          'Discourse returned an incomplete external-ID lookup response',
          false,
        );
      }
      if (categoryId !== configuration.categoryId) {
        throw new ConnectorError(
          ErrorCode.PLATFORM_API_ERROR,
          'Discourse external ID resolved to a topic in a different category',
          false,
        );
      }

      const firstPost = data.post_stream?.posts?.find(
        (candidate) => candidate.post_number === 1,
      ) ?? data.post_stream?.posts?.[0];
      const postId = this.positiveInteger(firstPost?.id);
      const reviewableId = this.positiveInteger(firstPost?.reviewable_id);
      const url = this.topicUrl(configuration.baseUrl, topicId, data.slug);
      const needsAction = data.visible === false
        || firstPost?.hidden === true
        || reviewableId !== undefined;
      if (needsAction) {
        return {
          externalId: String(topicId),
          url,
          status: 'NEEDS_ACTION',
          metadata: {
            moderationQueue: true,
            recoveredByExternalId: true,
            providerExternalId,
            externalPostId: String(topicId),
            url,
            ...(reviewableId === undefined ? {} : { reviewableId }),
          },
        };
      }
      return {
        externalId: String(topicId),
        url,
        status: 'PUBLISHED',
        metadata: {
          categoryId,
          recoveredByExternalId: true,
          providerExternalId,
          ...(postId === undefined ? {} : { postId }),
        },
      };
    } catch (lookupError) {
      if (this.isExternalIdNotFound(lookupError)) return undefined;
      throw lookupError;
    }
  }

  private isExternalIdNotFound(error: unknown): boolean {
    return error instanceof ConnectorError
      && error.code === ErrorCode.PLATFORM_CONTENT_REJECTED
      && error.safeDetails?.httpStatus === 404;
  }

  private isUncertainCreateFailure(error: unknown): error is ConnectorError {
    return error instanceof ConnectorError
      && [ErrorCode.PUBLISH_TIMEOUT, ErrorCode.PLATFORM_API_ERROR].includes(error.code);
  }

  private unreconciledCreateResult(
    providerExternalId: string,
    originalError: ConnectorError,
    lookupError?: unknown,
  ): PublishResult {
    // A timeout/5xx can happen after Discourse accepted a post into moderation,
    // before the topic becomes visible through the external-ID lookup. Automatic
    // retry would risk enqueuing the same topic twice, so require human reconciliation.
    const lookupConnectorError = lookupError instanceof ConnectorError
      ? lookupError
      : undefined;
    const accountReconnectRequired = lookupConnectorError !== undefined
      && [
        ErrorCode.PLATFORM_TOKEN_EXPIRED,
        ErrorCode.PLATFORM_AUTH_FAILED,
        ErrorCode.PLATFORM_PERMISSION_DENIED,
      ]
        .includes(lookupConnectorError.code);
    return {
      externalId: `pending:${providerExternalId}`,
      status: 'NEEDS_ACTION',
      metadata: {
        reconciliationRequired: true,
        submissionUncertain: true,
        providerExternalId,
        originalErrorCode: originalError.code,
        ...(lookupConnectorError
          ? { reconciliationLookupErrorCode: lookupConnectorError.code }
          : {}),
        ...(accountReconnectRequired ? { accountReconnectRequired: true } : {}),
      },
    };
  }

  private providerExternalId(idempotencyKey: string): string {
    return `sp-${sha256(idempotencyKey).slice(0, EXTERNAL_ID_HASH_LENGTH)}`;
  }

  private topicTags(value: unknown): Array<{ name: string }> {
    if (value === undefined || value === null) return [];
    const configuredTags = typeof value === 'string'
      ? value.split(',')
      : Array.isArray(value) && value.every((item) => typeof item === 'string')
        ? value
        : undefined;
    if (!configuredTags) {
      throw new ConnectorError(
        ErrorCode.PLATFORM_AUTH_FAILED,
        "Connector configuration 'defaultTags' must be a comma-separated string or string array",
        false,
      );
    }
    const tags: Array<{ name: string }> = [];
    const seen = new Set<string>();
    for (const configuredTag of configuredTags) {
      const name = configuredTag.trim().replace(/^#+/, '').trim();
      const deduplicationKey = name.toLowerCase();
      if (!name || seen.has(deduplicationKey)) continue;
      seen.add(deduplicationKey);
      tags.push({ name });
    }
    return tags;
  }

  private tagRequirements(category: NonNullable<DiscourseCategoryResponse['category']>): {
    reportedTagCountLowerBound: number;
    minimumRequiredTags: number;
    requiredTagGroups: DiscourseTagRequirement[];
  } {
    const minimumRequiredTags = category.minimum_required_tags === undefined
      ? 0
      : this.nonNegativeInteger(category.minimum_required_tags);
    if (minimumRequiredTags === undefined) {
      throw new ConnectorError(
        ErrorCode.PLATFORM_API_ERROR,
        'Discourse returned an invalid minimum_required_tags value',
        false,
      );
    }

    if (category.required_tag_groups !== undefined
      && !Array.isArray(category.required_tag_groups)) {
      throw new ConnectorError(
        ErrorCode.PLATFORM_API_ERROR,
        'Discourse returned an invalid required_tag_groups value',
        false,
      );
    }
    const requiredTagGroups = (category.required_tag_groups ?? []).map((value) => {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new ConnectorError(
          ErrorCode.PLATFORM_API_ERROR,
          'Discourse returned an invalid required tag group',
          false,
        );
      }
      const group = value as Record<string, unknown>;
      const minCount = this.positiveInteger(group.min_count);
      if (minCount === undefined) {
        throw new ConnectorError(
          ErrorCode.PLATFORM_API_ERROR,
          'Discourse returned an invalid required tag group minimum',
          false,
        );
      }
      const name = typeof group.name === 'string' ? group.name.trim() : '';
      return { minCount, ...(name ? { name } : {}) };
    });
    const reportedTagCountLowerBound = Math.max(
      minimumRequiredTags,
      0,
      ...requiredTagGroups.map(({ minCount }) => minCount),
    );
    return { reportedTagCountLowerBound, minimumRequiredTags, requiredTagGroups };
  }

  private topicUrl(baseUrl: string, topicId: number, rawSlug: unknown): string {
    const topicSlug = typeof rawSlug === 'string' ? rawSlug.trim() : '';
    const topicPath = topicSlug
      ? `/t/${encodeURIComponent(topicSlug)}/${topicId}`
      : `/t/${topicId}`;
    return `${baseUrl}${topicPath}`;
  }

  private objectResponse<T extends object>(value: unknown, message: string): T {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new ConnectorError(ErrorCode.PLATFORM_API_ERROR, message, false);
    }
    return value as T;
  }

  private positiveInteger(value: unknown): number | undefined {
    const normalized = typeof value === 'string' && /^\d+$/.test(value.trim())
      ? Number(value.trim())
      : value;
    return typeof normalized === 'number'
      && Number.isSafeInteger(normalized)
      && normalized > 0
      ? normalized
      : undefined;
  }

  private nonNegativeInteger(value: unknown): number | undefined {
    const normalized = typeof value === 'string' && /^\d+$/.test(value.trim())
      ? Number(value.trim())
      : value;
    return typeof normalized === 'number'
      && Number.isSafeInteger(normalized)
      && normalized >= 0
      ? normalized
      : undefined;
  }
}
