import { BrowserRecipeRegistry } from './browser-recipe.registry';
import { BrowserRecipesBootstrapService } from './browser-recipes-bootstrap.service';
import { VozXenForoBrowserRecipe } from './recipes/xenforo-browser.recipe';

describe('BrowserRecipesBootstrapService', () => {
  it('registers only the live-verified XenForo site recipe', () => {
    const registry = new BrowserRecipeRegistry();
    const voz = new VozXenForoBrowserRecipe();

    new BrowserRecipesBootstrapService(registry, voz).onModuleInit();

    expect(registry.get('voz-xenforo')).toBe(voz);
    expect(() => registry.get('directadmin-xenforo')).toThrow('not registered');
    expect(() => registry.get('tinhte-xenforo')).toThrow('not registered');
  });
});
