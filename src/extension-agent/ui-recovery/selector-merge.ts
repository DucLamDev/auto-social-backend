import type { ExtensionRecipe } from '../../connectors/extension/extension-delivery';

export interface ApprovedSelector { field: string; selector: string }

/** Recipe data sent to the extension, plus selectors for the composer opener. */
export type DeliveredRecipe = ExtensionRecipe & { openerSelectors?: string[] };

const MAX_PER_FIELD = 3;

function prepend(base: string[], extra: string[]): string[] {
  return [...new Set([...extra.slice(0, MAX_PER_FIELD), ...base])];
}

/**
 * Puts operator-approved selectors in front of the built-in ones. Returns a
 * copy: the shared recipe object is never mutated. Approved title/body
 * selectors also count as "the composer is ready".
 */
export function mergeApprovedSelectors(recipe: ExtensionRecipe, approved: ApprovedSelector[]): DeliveredRecipe {
  if (!approved.length) return recipe;
  const of = (field: string) => approved.filter((item) => item.field === field).map((item) => item.selector);
  const title = recipe.titleSelectors.length ? of('title') : [];
  const body = of('body');
  const opener = of('opener');
  return {
    ...recipe,
    readySelectors: prepend(recipe.readySelectors, [...title, ...body]),
    titleSelectors: prepend(recipe.titleSelectors, title),
    bodySelectors: prepend(recipe.bodySelectors, body),
    submitSelectors: prepend(recipe.submitSelectors, of('submit')),
    ...(opener.length ? { openerSelectors: opener.slice(0, MAX_PER_FIELD) } : {}),
  };
}
