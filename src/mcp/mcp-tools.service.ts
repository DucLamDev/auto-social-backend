import { HttpException, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { AccountStatus, Prisma, PublishJobStatus, RoleName } from '@prisma/client';
import { z } from 'zod';
import { AI_PROVIDER_IDS } from '../ai/ai-provider';
import { AiContentService } from '../ai/ai-content.service';
import { AuditService } from '../audit/audit.service';
import { CampaignAutomationService } from '../campaigns/campaign-automation.service';
import { CampaignsService } from '../campaigns/campaigns.service';
import { AutomateCampaignDto } from '../campaigns/dto/automate-campaign.dto';
import { sha256 } from '../common/utils/crypto.utils';
import { PrismaService } from '../database/prisma.service';
import { ExtensionAgentService } from '../extension-agent/extension-agent.service';
import { ExtensionLoginCheckService } from '../extension-agent/extension-login-check.service';
import { ExtensionSelectorSuggestionService } from '../extension-agent/ui-recovery/selector-suggestion.service';
import { PlatformAccountsService } from '../platform-accounts/platform-accounts.service';
import { ListPublishJobsQueryDto } from '../publishing/dto/list-publish-jobs-query.dto';
import { PublishJobsService } from '../publishing/publish-jobs.service';
import { RedisService } from '../queue/redis.service';
import { McpPrincipal } from './mcp-token.service';

const MAX_RESULT_CHARS = 200_000;
const ONLINE_WINDOW_MS = 90_000;
const EDITORS: RoleName[] = [RoleName.ADMIN, RoleName.EDITOR];

export interface McpToolContext {
  principal: McpPrincipal;
  requestId?: string;
}

interface McpToolDefinition {
  name: string;
  title: string;
  description: string;
  input: z.ZodObject;
  /** Write tools need the token's "write" scope and are audited. */
  access: 'read' | 'write';
  roles?: RoleName[];
  destructive?: boolean;
  /** Calls per hour per token, enforced with Redis when it is available. */
  hourlyLimit?: number;
  run: (context: McpToolContext, args: Record<string, unknown>) => Promise<unknown>;
}

function tool<S extends z.ZodObject>(definition: Omit<McpToolDefinition, 'input' | 'run'> & {
  input: S;
  run: (context: McpToolContext, args: z.output<S>) => Promise<unknown>;
}): McpToolDefinition {
  return definition as unknown as McpToolDefinition;
}

/** Raised inside a tool for an expected refusal; the message reaches the agent. */
class McpToolError extends Error {}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown, max = 2_000): string | null {
  return typeof value === 'string' ? value.slice(0, max) : null;
}

function failure(message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

/**
 * MCP tools for an AI agent (Codex) acting for the token owner. Every tool is
 * a thin wrapper over the same services and ownership rules as the REST API,
 * returns only non-secret fields, and never accepts code or selectors to run.
 */
@Injectable()
export class McpToolsService {
  private readonly logger = new Logger(McpToolsService.name);
  private readonly definitions: Map<string, McpToolDefinition>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
    private readonly accounts: PlatformAccountsService,
    private readonly agent: ExtensionAgentService,
    private readonly loginChecks: ExtensionLoginCheckService,
    private readonly jobs: PublishJobsService,
    private readonly campaigns: CampaignsService,
    private readonly automation: CampaignAutomationService,
    private readonly ai: AiContentService,
    private readonly suggestions: ExtensionSelectorSuggestionService,
    @Optional() private readonly redis?: RedisService,
  ) {
    this.definitions = new Map(this.buildTools().map((definition) => [definition.name, definition]));
  }

  toolNames(): string[] {
    return [...this.definitions.keys()];
  }

  /** A fresh stateless server per HTTP request, bound to the caller. */
  createServer(context: McpToolContext): McpServer {
    const server = new McpServer({ name: 'auto-social', version: '1.0.0' });
    for (const definition of this.definitions.values()) {
      server.registerTool(definition.name, {
        title: definition.title,
        description: definition.description,
        inputSchema: definition.input,
        annotations: {
          readOnlyHint: definition.access === 'read',
          destructiveHint: definition.destructive === true,
          openWorldHint: false,
        },
      }, (args: Record<string, unknown>) => this.call(context, definition.name, args));
    }
    return server;
  }

  async call(context: McpToolContext, name: string, rawArgs: unknown): Promise<CallToolResult> {
    const definition = this.definitions.get(name);
    if (!definition) return failure(`Unknown tool: ${name}`);
    const { principal } = context;
    const write = definition.access === 'write';
    const denied = write && !principal.scopes.includes('write')
      ? 'This MCP token is read-only.'
      : definition.roles && !definition.roles.some((role) => principal.roles.includes(role))
        ? `Your role cannot use ${name}. Required: ${definition.roles.join(' or ')}.`
        : null;
    if (denied) {
      if (write) await this.recordAudit(context, definition.name, undefined, 'DENIED');
      return failure(denied);
    }
    const parsed = definition.input.safeParse(rawArgs ?? {});
    if (!parsed.success) {
      return failure(`Invalid arguments: ${parsed.error.issues.map((issue) => `${issue.path.join('.') || 'input'}: ${issue.message}`).join('; ')}`);
    }
    const args = parsed.data;
    try {
      await this.enforceHourlyLimit(principal, definition);
      const result = await definition.run(context, args);
      if (write) await this.recordAudit(context, definition.name, typeof args.id === 'string' ? args.id : undefined, 'OK');
      let body = JSON.stringify(result ?? null, null, 2);
      if (body.length > MAX_RESULT_CHARS) body = `${body.slice(0, MAX_RESULT_CHARS)}\n… (truncated; narrow the query)`;
      return { content: [{ type: 'text', text: body }] };
    } catch (error) {
      if (write) await this.recordAudit(context, definition.name, typeof args.id === 'string' ? args.id : undefined, 'FAILED');
      return failure(this.safeMessage(name, error));
    }
  }

  private async enforceHourlyLimit(principal: McpPrincipal, definition: McpToolDefinition): Promise<void> {
    if (!definition.hourlyLimit || !this.redis) return;
    const usage = await this.redis.consumeRateLimit(`rate_limit:mcp-tool:${definition.name}:${principal.tokenId}`, definition.hourlyLimit, 3_600);
    if (!usage.allowed) throw new McpToolError(`${definition.name} is limited to ${definition.hourlyLimit} calls per hour for this token.`);
  }

  private async recordAudit(context: McpToolContext, toolName: string, entityId: string | undefined, outcome: 'OK' | 'FAILED' | 'DENIED') {
    // Arguments are not recorded: briefs and search text can be long or personal.
    await this.audit.recordBestEffort({
      actorId: context.principal.ownerId,
      action: `MCP_${toolName.toUpperCase()}`,
      entityType: 'mcp',
      entityId,
      requestId: context.requestId,
      after: { tokenId: context.principal.tokenId, outcome },
    });
  }

  private safeMessage(name: string, error: unknown): string {
    if (error instanceof McpToolError) return error.message;
    if (error instanceof HttpException) {
      const response = error.getResponse();
      const message = typeof response === 'string' ? response : record(response).message;
      if (typeof message === 'string') return message;
      if (Array.isArray(message)) return message.filter((item): item is string => typeof item === 'string').join('; ');
      return error.message;
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') return 'Not found for this account.';
    this.logger.error(`MCP tool ${name} failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    return 'The tool failed unexpectedly. Check the backend logs with the request id.';
  }

  private buildTools(): McpToolDefinition[] {
    const id = z.uuid();
    const tools: McpToolDefinition[] = [
      tool({
        name: 'list_accounts',
        title: 'List social accounts',
        description: 'Social accounts of the token owner with platform, connection status and whether a browser session is configured. Never returns credentials.',
        input: z.object({
          platform: z.string().max(80).optional().describe('Platform slug, e.g. devto, mastodon, medium'),
          status: z.enum(AccountStatus).optional(),
          limit: z.number().int().min(1).max(200).default(100),
        }),
        access: 'read',
        run: async ({ principal }, args) => {
          const accounts = await this.accounts.list(principal.ownerId);
          return accounts
            .filter((account) => (!args.platform || account.platform.slug === args.platform) && (!args.status || account.status === args.status))
            .slice(0, args.limit)
            .map((account) => {
              const settings = record(account.settings);
              return {
                id: account.id,
                name: account.name,
                username: account.username,
                enabled: account.enabled,
                status: account.status,
                lastTestedAt: account.lastTestedAt,
                platform: { slug: account.platform.slug, name: account.platform.name, mode: account.platform.mode, availability: account.platform.availability },
                credentialStatus: account.credential?.status ?? null,
                browserSessionConfigured: record(account).browserSessionConfigured === true,
                extensionSetupStatus: text(record(settings.extensionSetup).status, 80),
              };
            });
        },
      }),
      tool({
        name: 'list_extension_devices',
        title: 'List paired Chrome extensions',
        description: 'Paired Chrome profiles that run the publishing extension, with the last time each one polled the backend.',
        input: z.object({}),
        access: 'read',
        run: async ({ principal }) => {
          const devices = await this.agent.listDevices(principal.ownerId);
          const now = Date.now();
          return devices.map((device) => ({ ...device, online: Boolean(device.lastSeenAt && now - device.lastSeenAt.getTime() < ONLINE_WINDOW_MS) }));
        },
      }),
      tool({
        name: 'list_login_checks',
        title: 'List login checks',
        description: 'Per account: whether the extension session is configured, the latest login check result and whether posting is set up.',
        input: z.object({ limit: z.number().int().min(1).max(200).default(100) }),
        access: 'read',
        run: async ({ principal }, args) => (await this.loginChecks.list(principal.ownerId)).slice(0, args.limit),
      }),
      tool({
        name: 'queue_login_checks',
        title: 'Queue login checks',
        description: 'Ask the paired extension to verify the login of the given accounts (all configured accounts when omitted). Only checks the session; never posts.',
        input: z.object({
          accountIds: z.array(id).min(1).max(100).optional(),
          verifyOnly: z.boolean().default(true).describe('true: only confirm an existing session; false: may sign in with the stored login'),
        }),
        access: 'write',
        roles: [RoleName.ADMIN],
        hourlyLimit: 30,
        run: ({ principal }, args) => this.loginChecks.queue(principal.ownerId, args.accountIds, args.verifyOnly, false),
      }),
      tool({
        name: 'list_publish_jobs',
        title: 'List publish jobs',
        description: 'Publishing jobs (one per account and post) with status, last error and published URL, newest first.',
        input: z.object({
          status: z.enum(PublishJobStatus).optional(),
          search: z.string().max(200).optional().describe('Matches account, platform, campaign or post title'),
          page: z.number().int().min(1).default(1),
          limit: z.number().int().min(1).max(50).default(20),
        }),
        access: 'read',
        run: async ({ principal }, args) => {
          const query = Object.assign(new ListPublishJobsQueryDto(), { page: args.page, limit: args.limit, status: args.status, search: args.search });
          const result = await this.jobs.list(principal.ownerId, query);
          return {
            pagination: result.pagination,
            items: result.items.map((job) => ({
              id: job.id,
              status: job.status,
              scheduledAt: job.scheduledAt,
              updatedAt: job.updatedAt,
              attemptCount: job.attemptCount,
              lastErrorCode: job.lastErrorCode,
              lastErrorMessage: text(job.lastErrorMessage, 500),
              account: { id: job.platformAccount.id, name: job.platformAccount.name, platform: job.platformAccount.platform.slug },
              campaign: job.target.campaign,
              postTitle: job.target.contentVariant.title,
              publishedUrl: job.publishedPost?.url ?? null,
            })),
          };
        },
      }),
      tool({
        name: 'get_publish_job',
        title: 'Get a publish job',
        description: 'One publishing job with its recent attempts and errors.',
        input: z.object({ id }),
        access: 'read',
        run: ({ principal }, args) => this.prisma.publishJob.findFirstOrThrow({
          where: { id: args.id, target: { campaign: { ownerId: principal.ownerId } } },
          select: {
            id: true, status: true, scheduledAt: true, nextAttemptAt: true, attemptCount: true, maxAttempts: true,
            lastErrorCode: true, lastErrorMessage: true, createdAt: true, updatedAt: true,
            platformAccount: { select: { id: true, name: true, platform: { select: { slug: true, name: true } } } },
            target: { select: { campaign: { select: { id: true, name: true } }, contentVariant: { select: { id: true, title: true, status: true } } } },
            publishedPost: { select: { url: true, status: true, publishedAt: true } },
            attempts: { orderBy: { attemptNumber: 'desc' }, take: 5, select: { attemptNumber: true, status: true, errorCode: true, errorMessage: true, startedAt: true, finishedAt: true } },
          },
        }),
      }),
      tool({
        name: 'retry_publish_job',
        title: 'Retry a failed publish job',
        description: 'Queue a FAILED or RETRY job again. The backend still prevents duplicate posts.',
        input: z.object({ id }),
        access: 'write',
        roles: EDITORS,
        hourlyLimit: 60,
        run: ({ principal }, args) => this.jobs.retry(principal.ownerId, args.id),
      }),
      tool({
        name: 'requeue_extension_job',
        title: 'Give a job back to the Chrome extension',
        description: 'After a person confirmed nothing was posted (e.g. the editor was not found), put an extension job waiting for the operator back in the extension queue.',
        input: z.object({ id }),
        access: 'write',
        roles: EDITORS,
        hourlyLimit: 60,
        run: ({ principal }, args) => this.agent.requeue(principal.ownerId, args.id),
      }),
      tool({
        name: 'list_campaigns',
        title: 'List campaigns',
        description: 'Campaigns with AI automation state and publishing progress, newest first.',
        input: z.object({ limit: z.number().int().min(1).max(100).default(20) }),
        access: 'read',
        run: async ({ principal }, args) => (await this.campaigns.list(principal.ownerId)).slice(0, args.limit).map((campaign) => ({
          id: campaign.id,
          name: campaign.name,
          status: campaign.status,
          automationState: campaign.automationState,
          automationErrorCode: campaign.automationErrorCode,
          scheduledAt: campaign.scheduledAt,
          createdAt: campaign.createdAt,
          content: campaign.content,
          progress: campaign.progress,
        })),
      }),
      tool({
        name: 'get_campaign',
        title: 'Get a campaign',
        description: 'One campaign with each target account, its AI-written post and its publishing jobs.',
        input: z.object({ id }),
        access: 'read',
        run: async ({ principal }, args) => {
          const campaign = await this.campaigns.get(principal.ownerId, args.id);
          return {
            id: campaign.id,
            name: campaign.name,
            status: campaign.status,
            automationState: campaign.automationState,
            automationErrorCode: campaign.automationErrorCode,
            scheduledAt: campaign.scheduledAt,
            content: campaign.content,
            targets: campaign.targets.map((target) => ({
              account: target.platformAccount,
              post: {
                id: target.contentVariant.id,
                status: target.contentVariant.status,
                recommended: target.contentVariant.recommended,
                title: target.contentVariant.title,
                body: text(target.contentVariant.body, 4_000),
                hashtags: target.contentVariant.hashtags,
                reason: text(target.contentVariant.reason, 1_000),
              },
              jobs: target.publishJobs.map((job) => ({ id: job.id, status: job.status, scheduledAt: job.scheduledAt, lastErrorCode: job.lastErrorCode, lastErrorMessage: text(job.lastErrorMessage, 500) })),
            })),
          };
        },
      }),
      tool({
        name: 'ai_providers',
        title: 'List AI providers',
        description: 'AI providers the backend can use to write posts, with model and whether each is configured.',
        input: z.object({}),
        access: 'read',
        run: () => this.ai.providers(),
      }),
      tool({
        name: 'list_selector_suggestions',
        title: 'List AI selector suggestions',
        description: 'When the Chrome extension could not find a composer field after a site redesign, the AI proposed which element to use. Approved suggestions run with automatic submit; pending ones only pre-fill.',
        input: z.object({
          status: z.enum(['PENDING', 'APPROVED', 'REJECTED']).optional(),
          engine: z.string().max(40).optional(),
          limit: z.number().int().min(1).max(200).default(50),
        }),
        access: 'read',
        run: ({ principal }, args) => this.suggestions.list(principal.ownerId, args),
      }),
      tool({
        name: 'approve_selector_suggestion',
        title: 'Approve a selector suggestion',
        description: 'Let the extension use this AI-proposed selector with automatic submit on that site. Check sampleUrl and elementSummary first; only approve after a person confirmed it.',
        input: z.object({ id }),
        access: 'write',
        roles: [RoleName.ADMIN],
        run: ({ principal }, args) => this.suggestions.approve(principal.ownerId, args.id, principal.ownerId),
      }),
      tool({
        name: 'reject_selector_suggestion',
        title: 'Reject a selector suggestion',
        description: 'Never offer this AI-proposed selector to the extension again.',
        input: z.object({ id }),
        access: 'write',
        roles: [RoleName.ADMIN],
        run: ({ principal }, args) => this.suggestions.reject(principal.ownerId, args.id, principal.ownerId),
      }),
      tool({
        name: 'create_ai_campaign_draft',
        title: 'Create an AI campaign draft',
        description: 'AI writes one post per selected account from the brief. The campaign stops at "waiting for review": nothing is published until a person approves it in the web app.',
        input: z.object({
          name: z.string().trim().min(1).max(160),
          brief: z.string().trim().min(20).max(20_000).describe('What to promote: product, audience, key facts, call to action'),
          platformAccountIds: z.array(id).min(1).max(100).refine((ids) => new Set(ids).size === ids.length, 'must not repeat an account'),
          aiProvider: z.enum(AI_PROVIDER_IDS).optional(),
          scheduledAt: z.string().regex(/(?:[zZ]|[+-]\d{2}:?\d{2})$/, 'must include Z or a UTC offset').optional(),
          timezone: z.string().max(64).optional(),
        }),
        access: 'write',
        roles: EDITORS,
        hourlyLimit: 10,
        run: async (context, args) => {
          // A client retry of the same call replays the same campaign.
          const key = `mcp-${sha256(`${context.principal.tokenId}:${JSON.stringify(args)}`).slice(0, 48)}`;
          const dto = Object.assign(new AutomateCampaignDto(), { ...args, publishImmediately: false });
          const result = await this.automation.automate(context.principal.ownerId, dto, key, context.requestId, { enqueue: true });
          return this.campaignSummary(result.campaign, 'AI is writing the drafts. Review and approve them in the web app (Content waiting for review).');
        },
      }),
    ];
    if (this.config.get<boolean>('MCP_ALLOW_PUBLISH') === true) {
      tools.push(tool({
        name: 'approve_campaign',
        title: 'Approve and publish a campaign',
        description: 'Approves every AI draft of the campaign and starts REAL publishing on the social accounts (now or at scheduledAt). Only call this after a person asked for it.',
        input: z.object({
          id,
          confirm: z.literal(true).describe('Must be true: the posts become public'),
          publishMode: z.enum(['NOW', 'SCHEDULED']).default('NOW'),
          scheduledAt: z.string().regex(/(?:[zZ]|[+-]\d{2}:?\d{2})$/, 'must include Z or a UTC offset').optional(),
        }),
        access: 'write',
        roles: EDITORS,
        destructive: true,
        hourlyLimit: 5,
        run: async ({ principal }, args) => {
          const result = await this.automation.approve(principal.ownerId, args.id, { publishMode: args.publishMode, scheduledAt: args.scheduledAt });
          // Drafts left waiting (final AI approver, length, no ready account) are reported with their reasons.
          const held = [...(result.unapprovedVariants ?? []), ...(result.overLimitVariants ?? [])];
          return {
            ...this.campaignSummary(result.campaign, held.length
              ? 'Approved the ready drafts; the drafts listed in heldVariants keep waiting for review. Follow progress with list_publish_jobs.'
              : 'Approved. Follow progress with list_publish_jobs.'),
            ...(held.length ? { heldVariants: held.map(({ id, platform, message }) => ({ id, platform, message })) } : {}),
            ...(result.skippedAccounts?.length ? { skippedAccounts: result.skippedAccounts.map(({ name, platform, reasonLabel }) => ({ name, platform, reason: reasonLabel })) } : {}),
          };
        },
      }));
    }
    return tools;
  }

  private campaignSummary(campaign: { id: string; name: string; status: string; automationState?: string | null; automationErrorCode?: string | null }, next: string) {
    return { id: campaign.id, name: campaign.name, status: campaign.status, automationState: campaign.automationState ?? null, automationErrorCode: campaign.automationErrorCode ?? null, next };
  }
}
