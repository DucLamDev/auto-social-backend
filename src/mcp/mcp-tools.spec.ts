import { ConfigService } from '@nestjs/config';
import { RoleName } from '@prisma/client';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { AiContentService } from '../ai/ai-content.service';
import { AuditService } from '../audit/audit.service';
import { CampaignAutomationService } from '../campaigns/campaign-automation.service';
import { CampaignsService } from '../campaigns/campaigns.service';
import { PrismaService } from '../database/prisma.service';
import { ExtensionAgentService } from '../extension-agent/extension-agent.service';
import { ExtensionLoginCheckService } from '../extension-agent/extension-login-check.service';
import { ExtensionSelectorSuggestionService } from '../extension-agent/ui-recovery/selector-suggestion.service';
import { PlatformAccountsService } from '../platform-accounts/platform-accounts.service';
import { PublishJobsService } from '../publishing/publish-jobs.service';
import { RedisService } from '../queue/redis.service';
import { McpPrincipal } from './mcp-token.service';
import { McpToolsService } from './mcp-tools.service';

const ACCOUNT_ID = '7d0f1a2e-3b4c-4d5e-8f60-718293a4b5c6';
const editor: McpPrincipal = { tokenId: 'token-1', ownerId: 'owner-1', roles: [RoleName.EDITOR], scopes: ['read', 'write'] };

function setup(config: Record<string, unknown> = {}) {
  const mocks = {
    audit: { recordBestEffort: jest.fn().mockResolvedValue(undefined) },
    accounts: { list: jest.fn().mockResolvedValue([{
      id: ACCOUNT_ID, name: 'Dev.to VPSTTT', username: 'vpsttt', enabled: true, status: 'CONNECTED', lastTestedAt: null,
      settings: { extensionSetup: { status: 'CONFIGURED' }, extensionSession: { loginUsername: 'owner@example.com' } },
      platform: { slug: 'devto', name: 'DEV', mode: 'BROWSER_ASSISTED', availability: 'READY', defaultSettings: { secretish: true } },
      credential: { status: 'ACTIVE', expiresAt: null, updatedAt: new Date() }, browserSessionConfigured: true,
    }]) },
    agent: { listDevices: jest.fn().mockResolvedValue([{ id: 'device-1', name: 'Chrome A', lastSeenAt: new Date(), createdAt: new Date() }]), requeue: jest.fn().mockResolvedValue({ queued: true }) },
    loginChecks: { list: jest.fn().mockResolvedValue([]), queue: jest.fn().mockResolvedValue({ queued: 1 }) },
    jobs: { list: jest.fn(), retry: jest.fn().mockResolvedValue({ id: 'job-1', status: 'QUEUED' }) },
    campaigns: { list: jest.fn().mockResolvedValue([]), get: jest.fn() },
    automation: {
      automate: jest.fn().mockResolvedValue({ campaign: { id: 'campaign-1', name: 'Launch', status: 'DRAFT', automationState: 'PROCESSING', automationErrorCode: null } }),
      approve: jest.fn().mockResolvedValue({ campaign: { id: 'campaign-1', name: 'Launch', status: 'RUNNING', automationState: 'APPROVED', automationErrorCode: null } }),
    },
    ai: { providers: jest.fn().mockResolvedValue([]) },
    suggestions: { list: jest.fn().mockResolvedValue([]), approve: jest.fn().mockResolvedValue({ id: 's-1', status: 'APPROVED' }), reject: jest.fn() },
    redis: { consumeRateLimit: jest.fn().mockResolvedValue({ allowed: true, remaining: 9 }) },
  };
  const configService = { get: jest.fn((key: string) => config[key]) } as unknown as ConfigService;
  const service = new McpToolsService(
    {} as PrismaService, configService, mocks.audit as unknown as AuditService,
    mocks.accounts as unknown as PlatformAccountsService, mocks.agent as unknown as ExtensionAgentService,
    mocks.loginChecks as unknown as ExtensionLoginCheckService, mocks.jobs as unknown as PublishJobsService,
    mocks.campaigns as unknown as CampaignsService, mocks.automation as unknown as CampaignAutomationService,
    mocks.ai as unknown as AiContentService, mocks.suggestions as unknown as ExtensionSelectorSuggestionService,
    mocks.redis as unknown as RedisService,
  );
  return { service, mocks };
}

const textOf = (result: CallToolResult) => result.content.map((item) => (item.type === 'text' ? item.text : '')).join('');
const brief = { name: 'Launch', brief: 'Giới thiệu gói VPS mới cho lập trình viên, có backup hằng ngày.', platformAccountIds: [ACCOUNT_ID] };

describe('McpToolsService', () => {
  it('offers no publishing tool unless MCP_ALLOW_PUBLISH is enabled', () => {
    expect(setup().service.toolNames()).not.toContain('approve_campaign');
    expect(setup({ MCP_ALLOW_PUBLISH: true }).service.toolNames()).toContain('approve_campaign');
  });

  it('returns account metadata without settings, login names or credential payloads', async () => {
    const { service } = setup();
    const result = await service.call({ principal: editor }, 'list_accounts', {});
    expect(result.isError).toBeUndefined();
    const body = textOf(result);
    expect(JSON.parse(body)).toEqual([expect.objectContaining({ id: ACCOUNT_ID, credentialStatus: 'ACTIVE', extensionSetupStatus: 'CONFIGURED', browserSessionConfigured: true })]);
    expect(body).not.toContain('owner@example.com');
    expect(body).not.toContain('secretish');
  });

  it('scopes every call to the token owner', async () => {
    const { service, mocks } = setup();
    await service.call({ principal: editor }, 'list_extension_devices', {});
    await service.call({ principal: editor }, 'retry_publish_job', { id: ACCOUNT_ID });
    expect(mocks.agent.listDevices).toHaveBeenCalledWith('owner-1');
    expect(mocks.jobs.retry).toHaveBeenCalledWith('owner-1', ACCOUNT_ID);
  });

  it('refuses writes with a read-only token or a viewer role, and audits the refusal', async () => {
    const { service, mocks } = setup();
    const readOnly = await service.call({ principal: { ...editor, scopes: ['read'] } }, 'retry_publish_job', { id: ACCOUNT_ID });
    expect(readOnly).toMatchObject({ isError: true });
    expect(textOf(readOnly)).toContain('read-only');
    const viewer = await service.call({ principal: { ...editor, roles: [RoleName.VIEWER] } }, 'create_ai_campaign_draft', brief);
    expect(textOf(viewer)).toContain('Required: ADMIN or EDITOR');
    const editorQueuesChecks = await service.call({ principal: editor }, 'queue_login_checks', {});
    expect(textOf(editorQueuesChecks)).toContain('Required: ADMIN');
    expect(mocks.jobs.retry).not.toHaveBeenCalled();
    expect(mocks.automation.automate).not.toHaveBeenCalled();
    expect(mocks.loginChecks.queue).not.toHaveBeenCalled();
    expect(mocks.audit.recordBestEffort).toHaveBeenCalledWith(expect.objectContaining({ action: 'MCP_RETRY_PUBLISH_JOB', after: { tokenId: 'token-1', outcome: 'DENIED' } }));
  });

  it('creates a campaign draft that waits for review, with a stable idempotency key for retries', async () => {
    const { service, mocks } = setup();
    const first = await service.call({ principal: editor, requestId: 'req-1' }, 'create_ai_campaign_draft', brief);
    await service.call({ principal: editor, requestId: 'req-2' }, 'create_ai_campaign_draft', brief);
    expect(JSON.parse(textOf(first))).toMatchObject({ id: 'campaign-1', automationState: 'PROCESSING' });
    const calls = mocks.automation.automate.mock.calls as Array<[string, Record<string, unknown>, string, string, Record<string, unknown>]>;
    const [owner, dto, key, requestId, background] = calls[0] ?? [];
    const retryKey = calls[1]?.[2];
    expect(owner).toBe('owner-1');
    expect(dto).toMatchObject({ ...brief, publishImmediately: false });
    expect(background).toEqual({ enqueue: true });
    expect(requestId).toBe('req-1');
    expect(key).toMatch(/^mcp-[0-9a-f]{48}$/);
    expect(retryKey).toBe(key);
    expect(mocks.audit.recordBestEffort).toHaveBeenCalledWith(expect.objectContaining({ actorId: 'owner-1', action: 'MCP_CREATE_AI_CAMPAIGN_DRAFT', after: { tokenId: 'token-1', outcome: 'OK' } }));
    expect(JSON.stringify(mocks.audit.recordBestEffort.mock.calls)).not.toContain('backup');
  });

  it('lets only an ADMIN approve AI selector suggestions', async () => {
    const { service, mocks } = setup();
    const editorTry = await service.call({ principal: editor }, 'approve_selector_suggestion', { id: ACCOUNT_ID });
    expect(editorTry.isError).toBe(true);
    expect(mocks.suggestions.approve).not.toHaveBeenCalled();
    await service.call({ principal: { ...editor, roles: [RoleName.ADMIN] } }, 'approve_selector_suggestion', { id: ACCOUNT_ID });
    expect(mocks.suggestions.approve).toHaveBeenCalledWith('owner-1', ACCOUNT_ID, 'owner-1');
  });

  it('validates arguments before calling a service', async () => {
    const { service, mocks } = setup();
    const result = await service.call({ principal: editor }, 'create_ai_campaign_draft', { ...brief, platformAccountIds: ['not-a-uuid'] });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('platformAccountIds');
    expect(mocks.automation.automate).not.toHaveBeenCalled();
  });

  it('stops a tool once its hourly budget is used', async () => {
    const { service, mocks } = setup();
    mocks.redis.consumeRateLimit.mockResolvedValueOnce({ allowed: false, remaining: 0 });
    const result = await service.call({ principal: editor }, 'create_ai_campaign_draft', brief);
    expect(textOf(result)).toContain('10 calls per hour');
    expect(mocks.automation.automate).not.toHaveBeenCalled();
  });

  it('publishes only when enabled and explicitly confirmed', async () => {
    const { service, mocks } = setup({ MCP_ALLOW_PUBLISH: true });
    const unconfirmed = await service.call({ principal: editor }, 'approve_campaign', { id: ACCOUNT_ID });
    expect(unconfirmed.isError).toBe(true);
    expect(mocks.automation.approve).not.toHaveBeenCalled();
    const approved = await service.call({ principal: editor }, 'approve_campaign', { id: ACCOUNT_ID, confirm: true });
    expect(JSON.parse(textOf(approved))).toMatchObject({ status: 'RUNNING' });
    expect(mocks.automation.approve).toHaveBeenCalledWith('owner-1', ACCOUNT_ID, { publishMode: 'NOW', scheduledAt: undefined });
  });

  it('hides unexpected internal errors from the agent', async () => {
    const { service, mocks } = setup();
    mocks.agent.listDevices.mockRejectedValueOnce(new Error('connection string postgres://secret'));
    const result = await service.call({ principal: editor }, 'list_extension_devices', {});
    expect(result.isError).toBe(true);
    expect(textOf(result)).not.toContain('secret');
  });
});
