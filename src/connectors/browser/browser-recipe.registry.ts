import { Injectable } from '@nestjs/common';
import { BrowserPublishRecipe } from './browser-automation.types';
import { reviewedBrowserRecipeByKey } from './browser-recipe.manifest';

const POLICY_DISABLED_RECIPES = new Map<string, string>([
  [
    'medium',
    'Medium browser automation is disabled because Medium does not permit automated or programmatic access and posting without express written consent',
  ],
]);

export class BrowserRecipePolicyError extends Error {
  constructor(
    public readonly recipeKey: string,
    message: string,
  ) {
    super(message);
    this.name = 'BrowserRecipePolicyError';
  }
}

@Injectable()
export class BrowserRecipeRegistry {
  private readonly recipes = new Map<string, BrowserPublishRecipe>();

  /**
   * Only recipes that have passed a platform-policy review may be registered.
   * Keeping registration explicit lets future sanctioned adapters reuse the
   * browser infrastructure without silently re-enabling a blocked platform.
   */
  register(recipe: BrowserPublishRecipe): void {
    const key = recipe.key.trim().toLowerCase();
    this.assertPolicyAllows(key);
    const reviewed = reviewedBrowserRecipeByKey(key);
    if (!reviewed) {
      throw new BrowserRecipePolicyError(
        key,
        `Browser recipe '${key}' has not passed the platform and selector review`,
      );
    }
    const actualHosts = [...recipe.allowedHosts].map((host) => host.toLowerCase()).sort();
    const reviewedHosts = [...reviewed.allowedHosts].map((host) => host.toLowerCase()).sort();
    if (
      JSON.stringify(actualHosts) !== JSON.stringify(reviewedHosts)
      || recipe.finalSubmitPolicy !== reviewed.finalSubmitPolicy
      || Boolean(recipe.requiresAutomationPermissionAttestation)
        !== reviewed.requiresAutomationPermissionAttestation
      || Boolean(recipe.mediaPolicy) !== reviewed.mediaUploadSupported
    ) {
      throw new BrowserRecipePolicyError(
        key,
        `Browser recipe '${key}' does not match its reviewed security manifest`,
      );
    }
    if (this.recipes.has(key)) throw new Error(`Browser recipe '${key}' is already registered`);
    this.recipes.set(key, recipe);
  }

  get(key: string): BrowserPublishRecipe {
    const normalized = key.trim().toLowerCase();
    this.assertPolicyAllows(normalized);
    const recipe = this.recipes.get(normalized);
    if (!recipe) throw new Error(`Browser recipe '${normalized}' is not registered`);
    return recipe;
  }

  private assertPolicyAllows(key: string): void {
    const reason = POLICY_DISABLED_RECIPES.get(key);
    if (reason) throw new BrowserRecipePolicyError(key, reason);
  }
}
