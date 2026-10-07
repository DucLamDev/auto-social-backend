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
    const update = jest.fn().mockResolvedValue({});
    const prisma = {
      content: {
        findFirstOrThrow: jest.fn().mockResolvedValue({
          id: 'content-1', title: 'Title', body: 'Body', summary: null, canonicalUrl: null, status: 'APPROVED',
        }),
        update,
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
    expect(update).toHaveBeenNthCalledWith(1, { where: { id: 'content-1' }, data: { status: 'AI_GENERATING' } });
    expect(update).toHaveBeenNthCalledWith(2, { where: { id: 'content-1' }, data: { status: 'APPROVED' } });
  });
});
