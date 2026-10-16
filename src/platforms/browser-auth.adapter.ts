import type { PlatformAuthAdapter } from '../auth/auth.types';
import type { BrowserPublishRecipe } from '../connectors/browser/browser-automation.types';
import { vozAuthSelectors } from './voz-forums/auth.selectors';

/** Authentication is bound to the same compiled recipe/hosts as the publisher. */
export function browserAuthAdapter(recipe: BrowserPublishRecipe): PlatformAuthAdapter {
  return {
    allowedHosts: recipe.allowedHosts,
    selectors: recipe.authSelectors ?? (recipe.key === 'voz-xenforo' ? vozAuthSelectors : {}),
    isAuthenticated: (page) => recipe.isEditorReady(page),
  };
}
