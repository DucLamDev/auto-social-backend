import { MediumBrowserRecipe } from './medium-browser.recipe';

describe('MediumBrowserRecipe policy', () => {
  it('cannot inspect, draft, or submit Medium content', async () => {
    const recipe = new MediumBrowserRecipe();
    const context = {
      account: { id: 'account-1', settings: {}, credentials: {} },
      page: {} as never,
      post: { body: 'Draft', idempotencyKey: 'job-1' },
      mediaFiles: [],
    };
    expect(recipe.finalSubmitPolicy).toBe('HUMAN_REQUIRED');
    await expect(recipe.isEditorReady({} as never)).resolves.toBe(false);
    await expect(recipe.prepare(context)).rejects.toThrow('disabled');
    await expect(recipe.submit(context)).rejects.toThrow('disabled');
  });
});
