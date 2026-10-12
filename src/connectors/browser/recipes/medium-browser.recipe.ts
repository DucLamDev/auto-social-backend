import { Injectable } from '@nestjs/common';
import type { Page } from 'playwright';
import {
  BrowserPublishRecipe,
  BrowserRecipeContext,
  BrowserRecipePublishResult,
} from '../browser-automation.types';

const POLICY_MESSAGE = 'Medium browser automation is disabled without express written permission from Medium';

@Injectable()
export class MediumBrowserRecipe implements BrowserPublishRecipe {
  readonly key = 'medium';
  readonly allowedHosts = ['medium.com'] as const;
  readonly finalSubmitPolicy = 'HUMAN_REQUIRED' as const;

  startUrl(): string {
    return 'https://medium.com/new-story';
  }

  isEditorReady(page: Page): Promise<boolean> {
    void page;
    return Promise.resolve(false);
  }

  prepare(context: BrowserRecipeContext): Promise<void> {
    void context;
    return Promise.reject(new Error(POLICY_MESSAGE));
  }

  submit(context: BrowserRecipeContext): Promise<BrowserRecipePublishResult> {
    void context;
    return Promise.reject(new Error(POLICY_MESSAGE));
  }
}
