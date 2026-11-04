import { ConfigService } from '@nestjs/config';
import { AiImageService, IMAGE_ART_DIRECTION } from './ai-image.service';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('rest-of-image')]);

function serviceWith(values: Record<string, string>, generate?: jest.Mock) {
  const service = new AiImageService(new ConfigService(values));
  if (generate) Object.assign(service as unknown as { client: unknown }, { client: { images: { generate } } });
  return service;
}

const configured = { VPSTTT_AI_BASE_URL: 'https://ai.example.test/v1', VPSTTT_AI_API_KEY: 'test-key' }; // vpsttt-secretscan: ignore (key giả cho test)

describe('AI image generation through VPSTTT AI', () => {
  it('reports whether image generation is configured', () => {
    expect(serviceWith({}).status()).toEqual({ configured: false, model: 'vpsttt-image', provider: 'vpsttt' });
    expect(serviceWith(configured).status()).toEqual({ configured: true, model: 'vpsttt-image', provider: 'vpsttt' });
    expect(serviceWith({ ...configured, AI_IMAGE_ENABLED: 'false' }).status().configured).toBe(false);
  });

  it('asks for exactly one base64 image of the chosen size and checks its bytes', async () => {
    const generate = jest.fn().mockResolvedValue({ data: [{ b64_json: PNG.toString('base64') }] });
    const image = await serviceWith(configured, generate).generate('  A server rack in soft blue light  ', '1536x1024');
    expect(generate).toHaveBeenCalledWith({ model: 'vpsttt-image', prompt: `A server rack in soft blue light\n\n${IMAGE_ART_DIRECTION}`, size: '1536x1024', n: 1, response_format: 'b64_json' });
    expect(image).toEqual({ bytes: PNG, mimeType: 'image/png', model: 'vpsttt-image' });
  });

  it('rejects bytes that are not an image', async () => {
    const generate = jest.fn().mockResolvedValue({ data: [{ b64_json: Buffer.from('<html>').toString('base64') }] });
    await expect(serviceWith(configured, generate).generate('prompt', '1024x1024')).rejects.toThrow('không phải PNG');
  });

  it('says the key lacks the image scope when VPSTTT AI answers 403', async () => {
    const generate = jest.fn().mockRejectedValue(Object.assign(new Error('model_denied'), { status: 403 }));
    await expect(serviceWith(configured, generate).generate('prompt', '1024x1024')).rejects.toThrow('chưa có quyền tạo ảnh');
  });

  it('refuses unsupported sizes, empty prompts and a missing configuration before calling the API', async () => {
    const generate = jest.fn();
    const service = serviceWith(configured, generate);
    await expect(service.generate('prompt', '512x512' as never)).rejects.toThrow('Khổ ảnh');
    await expect(service.generate('   ', '1024x1024')).rejects.toThrow('trống');
    await expect(serviceWith({}).generate('prompt', '1024x1024')).rejects.toThrow('Chưa cấu hình tạo ảnh');
    expect(generate).not.toHaveBeenCalled();
  });

  it('adds the same quality direction to every prompt, including one edited by hand', async () => {
    const generate = jest.fn().mockResolvedValue({ data: [{ b64_json: PNG.toString('base64') }] });
    await serviceWith(configured, generate).generate('x'.repeat(5_000), '1024x1024');
    const sent = (generate.mock.calls[0] as [{ prompt: string }])[0].prompt;
    expect(sent.length).toBeLessThanOrEqual(4_000);
    expect(sent.endsWith(IMAGE_ART_DIRECTION)).toBe(true);
    expect(IMAGE_ART_DIRECTION).toMatch(/Never include text/);
  });
});

describe('AI image generation with OpenAI GPT Image', () => {
  const openai = { AI_IMAGE_PROVIDER: 'openai', OPENAI_API_KEY: 'test-openai-key' }; // vpsttt-secretscan: ignore (key giả cho test)

  it('uses OPENAI_API_KEY and gpt-image-1 at high quality, without the IDE-only response_format', async () => {
    expect(serviceWith({ AI_IMAGE_PROVIDER: 'openai' }).status()).toEqual({ configured: false, model: 'gpt-image-1', provider: 'openai' });
    expect(serviceWith(openai).status()).toEqual({ configured: true, model: 'gpt-image-1', provider: 'openai' });
    const generate = jest.fn().mockResolvedValue({ data: [{ b64_json: PNG.toString('base64') }] });
    const image = await serviceWith(openai, generate).generate('A server rack', '1536x1024');
    expect(generate).toHaveBeenCalledWith({ model: 'gpt-image-1', prompt: `A server rack\n\n${IMAGE_ART_DIRECTION}`, size: '1536x1024', n: 1, quality: 'high' });
    expect(image.model).toBe('gpt-image-1');
  });

  it('takes the model and quality from the environment and names OpenAI in errors', async () => {
    const generate = jest.fn().mockRejectedValue(Object.assign(new Error('org not verified'), { status: 403 }));
    const service = serviceWith({ ...openai, OPENAI_IMAGE_MODEL: 'gpt-image-1-mini', OPENAI_IMAGE_QUALITY: 'medium' }, generate);
    await expect(service.generate('prompt', '1024x1024')).rejects.toThrow('xác minh tổ chức');
    expect(generate).toHaveBeenCalledWith(expect.objectContaining({ model: 'gpt-image-1-mini', quality: 'medium' }));
    expect(serviceWith({ ...openai, OPENAI_IMAGE_QUALITY: 'ultra' }).status().configured).toBe(true);
    await expect(serviceWith({ AI_IMAGE_PROVIDER: 'openai' }).generate('prompt', '1024x1024')).rejects.toThrow('OPENAI_API_KEY');
  });
});
