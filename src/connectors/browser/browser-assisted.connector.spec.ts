import { BrowserAssistedConnector } from './browser-assisted.connector';
import { BrowserAutomationService } from './browser-automation.service';
import { BrowserPublishRecipe } from './browser-automation.types';
import { BrowserRecipePolicyError, BrowserRecipeRegistry } from './browser-recipe.registry';

describe('BrowserAssistedConnector', () => {
  const recipe = { key: 'approved-editor' } as BrowserPublishRecipe;
  const account = {
    id: 'account-1',
    settings: { browserRecipe: 'approved-editor' },
    credentials: { storageState: { cookies: [], origins: [] } },
  };
  const post = { title: 'Title', body: 'Body', idempotencyKey: 'job-1' };

  it('returns NEEDS_ACTION and reconnect metadata for a login challenge', async () => {
    const automation = {
      publish: jest.fn().mockResolvedValue({
        status: 'NEEDS_ACTION',
        reason: 'LOGIN_REQUIRED',
        message: 'Sign in',
        actionUrl: 'https://publisher.example/signin',
        accountReconnectRequired: true,
      }),
    } as unknown as BrowserAutomationService;
    const registry = { get: jest.fn().mockReturnValue(recipe) } as unknown as BrowserRecipeRegistry;
    const connector = new BrowserAssistedConnector(automation, registry);

    await expect(connector.publish(account, post)).resolves.toMatchObject({
      status: 'NEEDS_ACTION',
      metadata: {
        reason: 'LOGIN_REQUIRED',
        accountReconnectRequired: true,
      },
    });
  });

  it('never turns an uncertain browser submission into a retryable failure', async () => {
    const automation = {
      publish: jest.fn().mockResolvedValue({
        status: 'NEEDS_ACTION',
        reason: 'SUBMISSION_UNCERTAIN',
        message: 'Verify',
        challengeKind: 'TWO_FACTOR_REQUIRED',
        accountReconnectRequired: true,
        submissionUncertain: true,
      }),
    } as unknown as BrowserAutomationService;
    const connector = new BrowserAssistedConnector(automation, {
      get: jest.fn().mockReturnValue(recipe),
    } as unknown as BrowserRecipeRegistry);

    await expect(connector.publish(account, post)).resolves.toMatchObject({
      status: 'NEEDS_ACTION',
      metadata: {
        accountReconnectRequired: true,
        challengeKind: 'TWO_FACTOR_REQUIRED',
        reconciliationRequired: true,
        submissionUncertain: true,
      },
    });
  });

  it('turns a stale Medium browser account into a non-publishing policy handoff', async () => {
    const publish = jest.fn();
    const automation = { publish } as unknown as BrowserAutomationService;
    const registry = {
      get: jest.fn().mockImplementation(() => {
        throw new BrowserRecipePolicyError('medium', 'Medium browser automation is disabled');
      }),
    } as unknown as BrowserRecipeRegistry;
    const connector = new BrowserAssistedConnector(automation, registry);

    await expect(
      connector.publish(
        { ...account, settings: { browserRecipe: 'medium', browserAutoSubmit: true } },
        post,
      ),
    ).resolves.toMatchObject({
      status: 'NEEDS_ACTION',
      metadata: {
        browserAssisted: false,
        policyBlocked: true,
        browserRecipe: 'medium',
        reason: 'AUTOMATION_DISABLED',
      },
    });
    expect(publish).not.toHaveBeenCalled();
  });

  it('refuses to test a stale Medium browser account without opening a browser', async () => {
    const inspect = jest.fn();
    const automation = { inspect } as unknown as BrowserAutomationService;
    const registry = {
      get: jest.fn().mockImplementation(() => {
        throw new BrowserRecipePolicyError('medium', 'Medium browser automation is disabled');
      }),
    } as unknown as BrowserRecipeRegistry;
    const connector = new BrowserAssistedConnector(automation, registry);

    await expect(
      connector.testConnection({
        ...account,
        settings: { browserRecipe: 'medium' },
      }),
    ).rejects.toMatchObject({
      code: 'CONNECTOR_NEEDS_ACTION',
      retryable: false,
      safeDetails: { browserRecipe: 'medium', reason: 'POLICY_DISABLED' },
    });
    expect(inspect).not.toHaveBeenCalled();
  });

  it('rejects media unless the selected reviewed recipe explicitly opts in', async () => {
    const publish = jest.fn();
    const connector = new BrowserAssistedConnector(
      { publish } as unknown as BrowserAutomationService,
      { get: jest.fn().mockReturnValue(recipe) } as unknown as BrowserRecipeRegistry,
    );

    await expect(
      connector.publish(account, {
        ...post,
        media: [{ type: 'image', url: 'https://cdn.example.org/a.jpg' }],
      }),
    ).rejects.toMatchObject({ code: 'PLATFORM_MEDIA_INVALID', retryable: false });
    expect(publish).not.toHaveBeenCalled();
  });

  it('advertises only the globally bounded image capability', () => {
    const connector = new BrowserAssistedConnector(
      {} as BrowserAutomationService,
      {} as BrowserRecipeRegistry,
    );
    expect(connector.capability).toMatchObject({ image: true, video: false, maxImages: 4 });
  });
});
