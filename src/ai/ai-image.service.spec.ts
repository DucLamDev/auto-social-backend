import { ConfigService } from '@nestjs/config';
import { AiImageService } from './ai-image.service';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('rest-of-image')]);

function serviceWith(values: Record<string, string>, generate?: jest.Mock) {
  const service = new AiImageService(new ConfigService(values));
  if (generate) Object.assign(service as unknown as { client: unknown }, { client: { images: { generate } } });
  return service;
}

const configured = { VPSTTT_AI_BASE_URL: 'https://ai.example.test/v1', VPSTTT_AI_API_KEY: 'test-key' }; // vpsttt-secretscan: ignore (key giả cho test)

describe('AI image generation through VPSTTT AI', () => {
  it('reports whether image generation is configured', () => {
    expect(serviceWith({}).status()).toEqual({ configured: false, model: 'vpsttt-image' });
    expect(serviceWith(configured).status()).toEqual({ configured: true, model: 'vpsttt-image' });
    expect(serviceWith({ ...configured, AI_IMAGE_ENABLED: 'false' }).status().configured).toBe(false);
  });

  it('asks for exactly one base64 image of the chosen size and checks its bytes', async () => {
    const generate = jest.fn().mockResolvedValue({ data: [{ b64_json: PNG.toString('base64') }] });
    const image = await serviceWith(configured, generate).generate('  A server rack in soft blue light  ', '1536x1024');
    expect(generate).toHaveBeenCalledWith({ model: 'vpsttt-image', prompt: 'A server rack in soft blue light', size: '1536x1024', n: 1, response_format: 'b64_json' });
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
});
