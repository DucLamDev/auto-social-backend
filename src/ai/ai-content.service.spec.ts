import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../database/prisma.service';
import { AiContentService } from './ai-content.service';

describe('AiContentService structured parsing', () => {
  const service = new AiContentService({} as PrismaService, new ConfigService({}));

  it('accepts schema-compliant model output', () => {
    const result = service.parseOutput(JSON.stringify({
      platform: 'linkedin',
      title: 'A title',
      body: 'A useful body',
      summary: null,
      hashtags: ['nestjs'],
      cta: 'Discuss below',
      recommended: true,
      reason: 'Relevant audience',
      media: { type: 'image', altText: 'Architecture diagram' },
    }));
    expect(result.platform).toBe('linkedin');
    expect(result.recommended).toBe(true);
  });

  it('rejects invalid JSON and invalid schema output', () => {
    expect(() => service.parseOutput('{bad')).toThrow('AI returned invalid JSON');
    expect(() => service.parseOutput(JSON.stringify({ platform: 'x' }))).toThrow('required schema');
  });

  it('fails readiness before querying platforms when OPENAI_API_KEY is missing', async () => {
    const findMany = jest.fn();
    const unconfigured = new AiContentService(
      { platform: { findMany } } as unknown as PrismaService,
      new ConfigService({}),
    );

    await expect(unconfigured.assertReady(['devto'])).rejects.toThrow('OPENAI_API_KEY is not configured');
    expect(findMany).not.toHaveBeenCalled();
  });

  it('fails readiness when a selected platform has no active prompt', async () => {
    const configured = new AiContentService(
      {
        platform: {
          findMany: jest.fn().mockResolvedValue([{ slug: 'devto', prompts: [] }]),
        },
      } as unknown as PrismaService,
      new ConfigService({ OPENAI_API_KEY: 'test-key' }),
    );

    await expect(configured.assertReady(['devto'])).rejects.toThrow('No active AI prompt for: devto');
  });

  it('uses strict Responses Structured Outputs without server-side response storage', async () => {
    type Request = { store?: boolean; text?: { format?: { type?: string; strict?: boolean } } };
    const output = JSON.stringify({
      platform: 'x', title: null, body: 'Hello', summary: null, hashtags: [], cta: null,
      recommended: true, reason: 'Concise', media: { type: 'none', altText: '' },
    });
    const create = jest.fn<Promise<{ output_text: string }>, [Request]>().mockResolvedValue({ output_text: output });
    const configured = new AiContentService(
      {} as PrismaService,
      new ConfigService({ OPENAI_API_KEY: 'test-key', OPENAI_MODEL: 'gpt-5-mini' }),
    );
    const target = configured as unknown as {
      client: { responses: { create: (request: Request) => Promise<{ output_text: string }> } };
      callModel(platform: string, system: string, template: string, content: {
        title: string; body: string; summary: string | null; canonicalUrl: string | null;
      }): Promise<unknown>;
    };
    target.client = { responses: { create } };

    await target.callModel('x', 'Ground all claims.', '{{body}}', {
      title: 'Title', body: 'Source', summary: null, canonicalUrl: null,
    });

    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      store: false,
      text: { format: expect.objectContaining({ type: 'json_schema', strict: true }) as unknown },
    }));
  });

  it('restores the previous content status when generation fails', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const prisma = {
      content: {
        findFirstOrThrow: jest.fn().mockResolvedValue({
          id: 'content-1', title: 'Title', body: 'Body', summary: null, canonicalUrl: null, status: 'APPROVED',
        }),
        updateMany,
      },
      platform: {
        findMany: jest.fn().mockResolvedValue([{
          id: 'platform-1', slug: 'x', prompts: [{ systemPrompt: 'System', userTemplate: '{{body}}' }],
        }]),
      },
      contentVariant: {
        aggregate: jest.fn(),
        create: jest.fn(),
      },
    };
    const configured = new AiContentService(
      prisma as unknown as PrismaService,
      new ConfigService({ OPENAI_API_KEY: 'test-key' }),
    );
    const target = configured as unknown as {
      client: { responses: { create: () => Promise<{ output_text: string }> } };
    };
    target.client = { responses: { create: jest.fn().mockRejectedValue(new Error('provider down')) } };

    await expect(configured.generate('owner-1', 'content-1', ['x'])).rejects.toThrow('provider down');
    expect(updateMany).toHaveBeenNthCalledWith(1, {
      where: { id: 'content-1', ownerId: 'owner-1', status: 'APPROVED' },
      data: { status: 'AI_GENERATING' },
    });
    expect(updateMany).toHaveBeenNthCalledWith(2, {
      where: { id: 'content-1', ownerId: 'owner-1', status: 'AI_GENERATING' },
      data: { status: 'APPROVED' },
    });
  });

  it('does not persist partial variants when one platform generation fails', async () => {
    const transaction = jest.fn();
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const prisma = {
      content: {
        findFirstOrThrow: jest.fn().mockResolvedValue({
          id: 'content-1', title: 'Title', body: 'Body', summary: null, canonicalUrl: null, status: 'DRAFT',
        }),
        updateMany,
      },
      platform: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'platform-1', slug: 'x', prompts: [{ systemPrompt: 'System', userTemplate: '{{body}}' }] },
          { id: 'platform-2', slug: 'devto', prompts: [{ systemPrompt: 'System', userTemplate: '{{body}}' }] },
        ]),
      },
      $transaction: transaction,
    };
    const configured = new AiContentService(
      prisma as unknown as PrismaService,
      new ConfigService({ OPENAI_API_KEY: 'test-key' }),
    );
    const valid = JSON.stringify({
      platform: 'x', title: null, body: 'Hello', summary: null, hashtags: [], cta: null,
      recommended: true, reason: 'Concise', media: { type: 'none', altText: '' },
    });
    const target = configured as unknown as {
      client: { responses: { create: jest.Mock } };
    };
    target.client = {
      responses: {
        create: jest.fn()
          .mockResolvedValueOnce({ output_text: valid })
          .mockRejectedValueOnce(new Error('second platform failed')),
      },
    };

    await expect(configured.generate('owner-1', 'content-1', ['x', 'devto']))
      .rejects.toThrow('second platform failed');
    expect(transaction).not.toHaveBeenCalled();
    expect(updateMany).toHaveBeenLastCalledWith({
      where: { id: 'content-1', ownerId: 'owner-1', status: 'AI_GENERATING' },
      data: { status: 'DRAFT' },
    });
  });

  it('does not call the model when another request wins the atomic generation claim', async () => {
    const transaction = jest.fn();
    const prisma = {
      content: {
        findFirstOrThrow: jest.fn().mockResolvedValue({
          id: 'content-1', title: 'Title', body: 'Body', summary: null, canonicalUrl: null, status: 'DRAFT',
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      platform: {
        findMany: jest.fn().mockResolvedValue([{
          id: 'platform-1', slug: 'devto', prompts: [{ systemPrompt: 'System', userTemplate: '{{body}}' }],
        }]),
      },
      $transaction: transaction,
    };
    const configured = new AiContentService(
      prisma as unknown as PrismaService,
      new ConfigService({ OPENAI_API_KEY: 'test-key' }),
    );
    const create = jest.fn();
    const target = configured as unknown as { client: { responses: { create: jest.Mock } } };
    target.client = { responses: { create } };

    await expect(configured.generate('owner-1', 'content-1', ['devto']))
      .rejects.toThrow('Content changed while generation was starting');
    expect(create).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });
});
