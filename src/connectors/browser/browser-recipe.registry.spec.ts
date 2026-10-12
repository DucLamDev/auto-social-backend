import type { BrowserPublishRecipe } from './browser-automation.types';
import { BrowserRecipePolicyError, BrowserRecipeRegistry } from './browser-recipe.registry';

describe('BrowserRecipeRegistry', () => {
  it('blocks Medium even if stale configuration or code attempts to register it', () => {
    const registry = new BrowserRecipeRegistry();
    const medium = { key: 'medium' } as BrowserPublishRecipe;

    expect(() => registry.register(medium)).toThrow(BrowserRecipePolicyError);
    expect(() => registry.get(' MEDIUM ')).toThrow(BrowserRecipePolicyError);
  });

  it('registers a recipe only when it matches the reviewed security manifest', () => {
    const registry = new BrowserRecipeRegistry();
    const recipe = {
      key: 'voz-xenforo',
      allowedHosts: ['voz.vn'],
      finalSubmitPolicy: 'AUTOMATED',
      requiresAutomationPermissionAttestation: true,
    } as unknown as BrowserPublishRecipe;

    registry.register(recipe);

    expect(registry.get('VOZ-XENFORO')).toBe(recipe);
  });

  it('rejects unreviewed recipes and reviewed keys with a changed host boundary', () => {
    const registry = new BrowserRecipeRegistry();

    expect(() => registry.register({
      key: 'new-unreviewed-editor',
      allowedHosts: ['example.com'],
      finalSubmitPolicy: 'AUTOMATED',
    } as unknown as BrowserPublishRecipe)).toThrow(BrowserRecipePolicyError);
    expect(() => registry.register({
      key: 'voz-xenforo',
      allowedHosts: ['evil.example'],
      finalSubmitPolicy: 'AUTOMATED',
      requiresAutomationPermissionAttestation: true,
    } as unknown as BrowserPublishRecipe)).toThrow('does not match its reviewed security manifest');
  });
});
