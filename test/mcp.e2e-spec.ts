import { INestApplication, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { RoleName } from '@prisma/client';
import { AddressInfo } from 'node:net';
import { Server } from 'node:http';
import request from 'supertest';
import { AiContentService } from '../src/ai/ai-content.service';
import { AuditService } from '../src/audit/audit.service';
import { CampaignAutomationService } from '../src/campaigns/campaign-automation.service';
import { CampaignsService } from '../src/campaigns/campaigns.service';
import { GlobalExceptionFilter } from '../src/common/filters/global-exception.filter';
import { PrismaService } from '../src/database/prisma.service';
import { ExtensionAgentService } from '../src/extension-agent/extension-agent.service';
import { ExtensionLoginCheckService } from '../src/extension-agent/extension-login-check.service';
import { ExtensionSelectorSuggestionService } from '../src/extension-agent/ui-recovery/selector-suggestion.service';
import { McpController } from '../src/mcp/mcp.controller';
import { McpTokenGuard } from '../src/mcp/mcp-token.guard';
import { McpTokenService } from '../src/mcp/mcp-token.service';
import { McpToolsService } from '../src/mcp/mcp-tools.service';
import { PlatformAccountsService } from '../src/platform-accounts/platform-accounts.service';
import { PublishJobsService } from '../src/publishing/publish-jobs.service';

const TOKEN = 'mcp_e2e-test-token';

describe('MCP endpoint (e2e)', () => {
  let app: INestApplication;
  let url: URL;
  const config: Record<string, unknown> = { MCP_ENABLED: true, FRONTEND_URL: 'https://app.example.test', MCP_RATE_LIMIT_PER_MINUTE: 60 };
  const listDevices = jest.fn().mockResolvedValue([{ id: 'device-1', name: 'Chrome A', lastSeenAt: new Date(), createdAt: new Date() }]);

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [McpController],
      providers: [
        McpTokenGuard,
        McpToolsService,
        { provide: ConfigService, useValue: { get: (key: string, fallback?: unknown) => config[key] ?? fallback } },
        { provide: McpTokenService, useValue: { authenticate: jest.fn((header?: string) => {
          if (header !== `Bearer ${TOKEN}`) return Promise.reject(new UnauthorizedException('A valid MCP bearer token is required'));
          return Promise.resolve({ tokenId: 'token-1', ownerId: 'owner-1', roles: [RoleName.VIEWER], scopes: ['read'] });
        }) } },
        { provide: PrismaService, useValue: {} },
        { provide: AuditService, useValue: { recordBestEffort: jest.fn() } },
        { provide: PlatformAccountsService, useValue: { list: jest.fn().mockResolvedValue([]) } },
        { provide: ExtensionAgentService, useValue: { listDevices } },
        { provide: ExtensionLoginCheckService, useValue: {} },
        { provide: PublishJobsService, useValue: { retry: jest.fn() } },
        { provide: CampaignsService, useValue: {} },
        { provide: CampaignAutomationService, useValue: {} },
        { provide: AiContentService, useValue: { providers: jest.fn().mockResolvedValue([]) } },
        { provide: ExtensionSelectorSuggestionService, useValue: { list: jest.fn().mockResolvedValue([]) } },
      ],
    }).compile();
    app = module.createNestApplication();
    app.useGlobalFilters(new GlobalExceptionFilter());
    await app.listen(0, '127.0.0.1');
    const address = (app.getHttpServer() as Server).address() as AddressInfo;
    url = new URL(`http://127.0.0.1:${address.port}/mcp`);
  });

  afterAll(async () => app.close());

  it('lists and calls tools through the official MCP client', async () => {
    const client = new Client({ name: 'e2e', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } }));
    const { tools } = await client.listTools();
    expect(tools.map((item) => item.name)).toEqual(expect.arrayContaining(['list_accounts', 'list_publish_jobs', 'create_ai_campaign_draft']));
    expect(tools.map((item) => item.name)).not.toContain('approve_campaign');
    const devices = await client.callTool({ name: 'list_extension_devices', arguments: {} });
    expect(JSON.stringify(devices.content)).toContain('Chrome A');
    expect(listDevices).toHaveBeenCalledWith('owner-1');
    const refused = await client.callTool({ name: 'retry_publish_job', arguments: { id: '7d0f1a2e-3b4c-4d5e-8f60-718293a4b5c6' } });
    expect(refused.isError).toBe(true);
    await client.close();
  });

  it('rejects calls without a valid token', async () => {
    await request(app.getHttpServer() as Server).post('/mcp').set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' }).expect(401);
  });

  it('rejects a browser page from another origin', async () => {
    await request(app.getHttpServer() as Server).post('/mcp').set('Origin', 'https://evil.example')
      .set('Authorization', `Bearer ${TOKEN}`).send({ jsonrpc: '2.0', id: 1, method: 'tools/list' }).expect(403);
  });

  it('only answers POST', async () => {
    await request(app.getHttpServer() as Server).get('/mcp').set('Authorization', `Bearer ${TOKEN}`).expect(405);
  });

  it('is hidden while MCP_ENABLED is off', async () => {
    config.MCP_ENABLED = false;
    try {
      await request(app.getHttpServer() as Server).post('/mcp').set('Authorization', `Bearer ${TOKEN}`).send({}).expect(404);
    } finally {
      config.MCP_ENABLED = true;
    }
  });
});
