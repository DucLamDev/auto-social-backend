import { Injectable } from '@nestjs/common';
import { PlatformMode } from '@prisma/client';
import { ErrorCode } from '../../common/exceptions/application.exception';
import { sha256 } from '../../common/utils/crypto.utils';
import { ConnectorError } from '../core/connector-error';
import {
  ConnectionTestResult,
  ConnectorAccount,
  PostPayload,
  PublishResult,
} from '../core/connector.types';
import { SocialPublisher } from '../core/social-publisher.interface';
import { BrowserAutomationService } from './browser-automation.service';
import type { BrowserPublishRecipe } from './browser-automation.types';
import { BrowserRecipePolicyError, BrowserRecipeRegistry } from './browser-recipe.registry';
import {
  assertBrowserRecipeAcceptsMedia,
  MAX_BROWSER_IMAGE_COUNT,
} from './browser-media-preparation.service';

@Injectable()
export class BrowserAssistedConnector implements SocialPublisher {
  readonly platform = 'browser-assisted';
  readonly mode = PlatformMode.BROWSER_ASSISTED;
  readonly capability = {
    text: true,
    image: true,
    video: false,
    article: true,
    delete: false,
    schedule: false,
    analytics: false,
    maxImages: MAX_BROWSER_IMAGE_COUNT,
  };

  constructor(
    private readonly automation: BrowserAutomationService,
    private readonly recipes: BrowserRecipeRegistry,
  ) {}

  validate(post: PostPayload): Promise<void> {
    if (!post.body.trim()) {
      throw new ConnectorError(ErrorCode.PLATFORM_CONTENT_REJECTED, 'Post body is required', false);
    }
    if (post.media?.some((asset) => asset.type !== 'image')) {
      throw new ConnectorError(
        ErrorCode.PLATFORM_MEDIA_INVALID,
        'Browser-assisted publishing only accepts images',
        false,
      );
    }
    return Promise.resolve();
  }

  async publish(account: ConnectorAccount, post: PostPayload): Promise<PublishResult> {
    await this.validate(post);
    let recipe: BrowserPublishRecipe;
    try {
      recipe = this.recipes.get(this.recipeKey(account));
    } catch (error) {
      if (!(error instanceof BrowserRecipePolicyError)) throw error;
      return {
        externalId: `browser-action:${sha256(post.idempotencyKey).slice(0, 32)}`,
        status: 'NEEDS_ACTION',
        metadata: {
          browserAssisted: false,
          policyBlocked: true,
          browserRecipe: error.recipeKey,
          reason: 'AUTOMATION_DISABLED',
          message: error.message,
        },
      };
    }
    assertBrowserRecipeAcceptsMedia(recipe, post.media);
    const result = await this.automation.publish(account, post, recipe);
    if (result.status === 'PUBLISHED') {
      return {
        externalId: result.externalId,
        url: result.url,
        status: 'PUBLISHED',
        metadata: result.metadata,
      };
    }
    return {
      externalId: `browser-action:${sha256(post.idempotencyKey).slice(0, 32)}`,
      status: 'NEEDS_ACTION',
      metadata: {
        browserAssisted: true,
        browserRecipe: recipe.key,
        reason: result.reason,
        message: result.message,
        ...(result.actionUrl ? { actionUrl: result.actionUrl } : {}),
        ...(result.accountReconnectRequired ? { accountReconnectRequired: true } : {}),
        ...(result.challengeKind ? { challengeKind: result.challengeKind } : {}),
        ...(result.submissionUncertain
          ? {
              reconciliationRequired: true,
              submissionUncertain: true,
            }
          : {}),
      },
    };
  }

  async testConnection(account: ConnectorAccount): Promise<ConnectionTestResult> {
    let recipe: BrowserPublishRecipe;
    try {
      recipe = this.recipes.get(this.recipeKey(account));
    } catch (error) {
      if (!(error instanceof BrowserRecipePolicyError)) throw error;
      throw new ConnectorError(ErrorCode.CONNECTOR_NEEDS_ACTION, error.message, false, undefined, {
        browserRecipe: error.recipeKey,
        reason: 'POLICY_DISABLED',
      });
    }
    const inspection = await this.automation.inspect(account, recipe);
    if (!inspection.ready) {
      throw new ConnectorError(
        ErrorCode.CONNECTOR_NEEDS_ACTION,
        inspection.message,
        false,
        undefined,
        {
          browserRecipe: recipe.key,
          ...(inspection.challenge ? { reason: inspection.challenge.kind } : {}),
          ...(inspection.actionUrl ? { actionUrl: inspection.actionUrl } : {}),
        },
      );
    }
    return {
      ok: true,
      ready: true,
      manual: false,
      accountName: account.username,
      message: inspection.message,
      details: { browserRecipe: recipe.key, encryptedSessionState: true },
    };
  }

  private recipeKey(account: ConnectorAccount): string {
    const key = account.settings.browserRecipe;
    if (typeof key !== 'string' || !key.trim()) {
      throw new ConnectorError(
        ErrorCode.CONNECTOR_NEEDS_ACTION,
        'A built-in browserRecipe must be selected for this account',
        false,
      );
    }
    return key.trim().toLowerCase();
  }
}
