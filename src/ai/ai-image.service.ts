import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { ApplicationException, ErrorCode } from '../common/exceptions/application.exception';
import { ProviderThrottle } from './provider-throttle';

/** Sizes accepted by the IDE AI API image endpoint. */
export const AI_IMAGE_SIZES = ['1024x1024', '1536x1024', '1024x1536'] as const;
export type AiImageSize = (typeof AI_IMAGE_SIZES)[number];

/** The IDE AI API accepts prompts of at most 12,000 characters. */
const MAX_PROMPT_CHARS = 4_000;

const IMAGE_SIGNATURES: Array<{ mimeType: string; matches: (body: Buffer) => boolean }> = [
  { mimeType: 'image/png', matches: (body) => body.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mimeType: 'image/jpeg', matches: (body) => body.length >= 3 && body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff },
  { mimeType: 'image/webp', matches: (body) => body.subarray(0, 4).toString('ascii') === 'RIFF' && body.subarray(8, 12).toString('ascii') === 'WEBP' },
];

export interface GeneratedImage {
  bytes: Buffer;
  mimeType: string;
  model: string;
}

export interface AiImageStatus {
  configured: boolean;
  model: string;
}

/**
 * Generates one image per call through the company IDE AI API
 * (OpenAI-compatible `POST /images/generations`, model `vpsttt-image`).
 * Each image runs a slow Codex session counted against the key quota, so
 * calls are serialized by default and never retried by the SDK.
 */
@Injectable()
export class AiImageService {
  private readonly client?: OpenAI;
  private readonly model: string;
  private readonly throttle: ProviderThrottle;

  constructor(config: ConfigService) {
    this.model = config.get<string>('VPSTTT_AI_IMAGE_MODEL', 'vpsttt-image').trim() || 'vpsttt-image';
    this.throttle = new ProviderThrottle(
      Math.max(1, Number(config.get<number>('VPSTTT_AI_IMAGE_CONCURRENCY', 1)) || 1),
      Math.max(1, Number(config.get<number>('VPSTTT_AI_IMAGE_RPM', 6)) || 6),
    );
    const enabled = String(config.get<string>('AI_IMAGE_ENABLED', 'true')).trim().toLowerCase() !== 'false';
    const baseURL = config.get<string>('VPSTTT_AI_BASE_URL')?.trim();
    const apiKey = config.get<string>('VPSTTT_AI_API_KEY')?.trim();
    if (enabled && baseURL && apiKey) {
      this.client = new OpenAI({
        apiKey,
        baseURL,
        timeout: Number(config.get<number>('VPSTTT_AI_IMAGE_TIMEOUT_MS', 300_000)) || 300_000,
        maxRetries: 0,
      });
    }
  }

  status(): AiImageStatus {
    return { configured: Boolean(this.client), model: this.model };
  }

  async generate(prompt: string, size: AiImageSize): Promise<GeneratedImage> {
    const client = this.client;
    if (!client) {
      throw new ApplicationException(ErrorCode.INFRASTRUCTURE_UNAVAILABLE,
        'Chưa cấu hình tạo ảnh: cần VPSTTT_AI_BASE_URL, VPSTTT_AI_API_KEY và AI_IMAGE_ENABLED khác false.', HttpStatus.SERVICE_UNAVAILABLE);
    }
    const text = prompt.trim().slice(0, MAX_PROMPT_CHARS);
    if (!text) throw new ApplicationException(ErrorCode.VALIDATION_FAILED, 'Mô tả ảnh đang trống.', HttpStatus.BAD_REQUEST);
    if (!(AI_IMAGE_SIZES as readonly string[]).includes(size)) {
      throw new ApplicationException(ErrorCode.VALIDATION_FAILED, `Khổ ảnh ${String(size)} không được hỗ trợ.`, HttpStatus.BAD_REQUEST);
    }
    let encoded: string | undefined;
    try {
      const response = await this.throttle.run(() => client.images.generate({ model: this.model, prompt: text, size, n: 1, response_format: 'b64_json' }));
      encoded = response.data?.[0]?.b64_json ?? undefined;
    } catch (error) {
      throw this.normalizeError(error);
    }
    if (!encoded) throw new ApplicationException(ErrorCode.PLATFORM_API_ERROR, 'VPSTTT AI không trả về ảnh.', HttpStatus.BAD_GATEWAY);
    const bytes = Buffer.from(encoded, 'base64');
    const format = IMAGE_SIGNATURES.find((candidate) => candidate.matches(bytes));
    if (!format) throw new ApplicationException(ErrorCode.PLATFORM_API_ERROR, 'Ảnh VPSTTT AI trả về không phải PNG, JPEG hoặc WebP.', HttpStatus.BAD_GATEWAY);
    return { bytes, mimeType: format.mimeType, model: this.model };
  }

  private normalizeError(error: unknown): ApplicationException {
    const status = typeof error === 'object' && error !== null && typeof (error as { status?: unknown }).status === 'number'
      ? (error as { status: number }).status : undefined;
    if (status === 401) {
      return new ApplicationException(ErrorCode.PLATFORM_AUTH_FAILED, 'VPSTTT AI từ chối key. Kiểm tra VPSTTT_AI_API_KEY và IP được phép của key.', HttpStatus.BAD_GATEWAY);
    }
    if (status === 403) {
      return new ApplicationException(ErrorCode.PLATFORM_PERMISSION_DENIED, 'Key VPSTTT AI chưa có quyền tạo ảnh. Nhờ quản trị cấp quyền "image" (model vpsttt-image) cho key.', HttpStatus.BAD_GATEWAY);
    }
    if (status === 429) {
      return new ApplicationException(ErrorCode.PLATFORM_RATE_LIMITED, 'VPSTTT AI đang giới hạn lượt tạo ảnh. Thử tạo lại ảnh sau ít phút.', HttpStatus.TOO_MANY_REQUESTS);
    }
    if (status === 400) {
      return new ApplicationException(ErrorCode.PLATFORM_API_ERROR, 'VPSTTT AI từ chối yêu cầu tạo ảnh (mô tả hoặc khổ ảnh chưa hợp lệ).', HttpStatus.BAD_GATEWAY);
    }
    if (status === 503) {
      return new ApplicationException(ErrorCode.INFRASTRUCTURE_UNAVAILABLE, 'VPSTTT AI chưa có tài khoản tạo ảnh khả dụng. Thử lại sau.', HttpStatus.SERVICE_UNAVAILABLE);
    }
    return new ApplicationException(ErrorCode.INFRASTRUCTURE_UNAVAILABLE, 'Không tạo được ảnh bằng VPSTTT AI (mất kết nối hoặc quá thời gian).', HttpStatus.SERVICE_UNAVAILABLE);
  }
}
