import { HttpStatus, Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { ApplicationException, ErrorCode } from '../common/exceptions/application.exception';
import { ProviderThrottle } from './provider-throttle';
import { VpstttQuota } from './vpsttt-quota';

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
  provider: AiImageProvider;
}

/** `vpsttt`: IDE AI API (Codex image account); `openai`: OpenAI Images API (GPT Image) with OPENAI_API_KEY. */
export type AiImageProvider = 'vpsttt' | 'openai';
const OPENAI_QUALITIES = ['low', 'medium', 'high', 'auto'] as const;
type OpenAiQuality = (typeof OPENAI_QUALITIES)[number];

/**
 * Appended to every prompt (also prompts edited by hand before "Tạo lại ảnh"):
 * the writer's short description says what to show, this says how well.
 */
export const IMAGE_ART_DIRECTION = 'Quality: a polished, high-detail professional image with deliberate composition, one clear focal subject, '
  + 'realistic materials, considered lighting and depth, and clean negative space. Never include text, letters, numbers, logos, '
  + 'watermarks or readable interface text; no distorted or melted hardware, no clutter, no clip-art.';

/**
 * Generates one image per call, either through the company IDE AI API
 * (OpenAI-compatible `POST /images/generations`, model `vpsttt-image`, which
 * runs a slow Codex session counted against the key quota) or directly with
 * OpenAI's GPT Image models. Calls are throttled and never retried by the SDK.
 */
@Injectable()
export class AiImageService {
  private readonly client?: OpenAI;
  private readonly provider: AiImageProvider;
  private readonly model: string;
  private readonly quality: OpenAiQuality;
  private readonly throttle: ProviderThrottle;

  constructor(config: ConfigService, @Optional() private readonly vpstttQuota?: VpstttQuota) {
    this.provider = String(config.get<string>('AI_IMAGE_PROVIDER', 'vpsttt')).trim().toLowerCase() === 'openai' ? 'openai' : 'vpsttt';
    const openai = this.provider === 'openai';
    this.model = openai
      ? config.get<string>('OPENAI_IMAGE_MODEL', 'gpt-image-1').trim() || 'gpt-image-1'
      : config.get<string>('VPSTTT_AI_IMAGE_MODEL', 'vpsttt-image').trim() || 'vpsttt-image';
    const quality = String(config.get<string>('OPENAI_IMAGE_QUALITY', 'high')).trim().toLowerCase();
    this.quality = (OPENAI_QUALITIES as readonly string[]).includes(quality) ? quality as OpenAiQuality : 'high';
    this.throttle = new ProviderThrottle(
      Math.max(1, Number(config.get<number>(openai ? 'OPENAI_IMAGE_CONCURRENCY' : 'VPSTTT_AI_IMAGE_CONCURRENCY', openai ? 2 : 1)) || 1),
      Math.max(1, Number(config.get<number>(openai ? 'OPENAI_IMAGE_RPM' : 'VPSTTT_AI_IMAGE_RPM', openai ? 10 : 6)) || 6),
    );
    const enabled = String(config.get<string>('AI_IMAGE_ENABLED', 'true')).trim().toLowerCase() !== 'false';
    const baseURL = openai ? undefined : config.get<string>('VPSTTT_AI_BASE_URL')?.trim();
    const apiKey = config.get<string>(openai ? 'OPENAI_API_KEY' : 'VPSTTT_AI_API_KEY')?.trim();
    if (enabled && apiKey && (openai || baseURL)) {
      this.client = new OpenAI({
        apiKey,
        ...(baseURL ? { baseURL } : {}),
        timeout: Number(config.get<number>(openai ? 'OPENAI_IMAGE_TIMEOUT_MS' : 'VPSTTT_AI_IMAGE_TIMEOUT_MS', 300_000)) || 300_000,
        maxRetries: 0,
      });
    }
  }

  status(): AiImageStatus {
    return { configured: Boolean(this.client), model: this.model, provider: this.provider };
  }

  private get label(): string {
    return this.provider === 'openai' ? 'OpenAI' : 'VPSTTT AI';
  }

  async generate(prompt: string, size: AiImageSize): Promise<GeneratedImage> {
    const client = this.client;
    if (!client) {
      throw new ApplicationException(ErrorCode.INFRASTRUCTURE_UNAVAILABLE, this.provider === 'openai'
        ? 'Chưa cấu hình tạo ảnh: AI_IMAGE_PROVIDER=openai cần OPENAI_API_KEY và AI_IMAGE_ENABLED khác false.'
        : 'Chưa cấu hình tạo ảnh: cần VPSTTT_AI_BASE_URL, VPSTTT_AI_API_KEY và AI_IMAGE_ENABLED khác false.', HttpStatus.SERVICE_UNAVAILABLE);
    }
    const described = prompt.trim();
    if (!described) throw new ApplicationException(ErrorCode.VALIDATION_FAILED, 'Mô tả ảnh đang trống.', HttpStatus.BAD_REQUEST);
    const text = `${described.slice(0, MAX_PROMPT_CHARS - IMAGE_ART_DIRECTION.length - 2)}\n\n${IMAGE_ART_DIRECTION}`;
    if (!(AI_IMAGE_SIZES as readonly string[]).includes(size)) {
      throw new ApplicationException(ErrorCode.VALIDATION_FAILED, `Khổ ảnh ${String(size)} không được hỗ trợ.`, HttpStatus.BAD_REQUEST);
    }
    let encoded: string | undefined;
    try {
      // GPT Image models always answer base64 and reject response_format; the IDE API needs it.
      const request = this.provider === 'openai'
        ? { model: this.model, prompt: text, size, n: 1, quality: this.quality }
        : { model: this.model, prompt: text, size, n: 1, response_format: 'b64_json' as const };
      // VPSTTT images also count against the quota the writing calls use.
      const call = () => client.images.generate(request);
      const response = await this.throttle.run(() => (this.provider === 'vpsttt' && this.vpstttQuota ? this.vpstttQuota.run(call) : call()));
      encoded = response.data?.[0]?.b64_json ?? undefined;
    } catch (error) {
      throw this.normalizeError(error);
    }
    if (!encoded) throw new ApplicationException(ErrorCode.PLATFORM_API_ERROR, `${this.label} không trả về ảnh.`, HttpStatus.BAD_GATEWAY);
    const bytes = Buffer.from(encoded, 'base64');
    const format = IMAGE_SIGNATURES.find((candidate) => candidate.matches(bytes));
    if (!format) throw new ApplicationException(ErrorCode.PLATFORM_API_ERROR, `Ảnh ${this.label} trả về không phải PNG, JPEG hoặc WebP.`, HttpStatus.BAD_GATEWAY);
    return { bytes, mimeType: format.mimeType, model: this.model };
  }

  private normalizeError(error: unknown): ApplicationException {
    const status = typeof error === 'object' && error !== null && typeof (error as { status?: unknown }).status === 'number'
      ? (error as { status: number }).status : undefined;
    const openai = this.provider === 'openai';
    if (status === 401) {
      return new ApplicationException(ErrorCode.PLATFORM_AUTH_FAILED, openai
        ? 'OpenAI từ chối key. Kiểm tra OPENAI_API_KEY.'
        : 'VPSTTT AI từ chối key. Kiểm tra VPSTTT_AI_API_KEY và IP được phép của key.', HttpStatus.BAD_GATEWAY);
    }
    if (status === 403) {
      return new ApplicationException(ErrorCode.PLATFORM_PERMISSION_DENIED, openai
        ? `Tài khoản OpenAI chưa được dùng model ${this.model} (GPT Image cần xác minh tổ chức trên OpenAI).`
        : 'Key VPSTTT AI chưa có quyền tạo ảnh. Nhờ quản trị cấp quyền "image" (model vpsttt-image) cho key.', HttpStatus.BAD_GATEWAY);
    }
    if (status === 429) {
      return new ApplicationException(ErrorCode.PLATFORM_RATE_LIMITED, `${this.label} đang giới hạn lượt tạo ảnh hoặc hết hạn mức. Thử tạo lại ảnh sau ít phút.`, HttpStatus.TOO_MANY_REQUESTS);
    }
    if (status === 400) {
      return new ApplicationException(ErrorCode.PLATFORM_API_ERROR, `${this.label} từ chối yêu cầu tạo ảnh (mô tả bị chặn hoặc khổ ảnh chưa hợp lệ).`, HttpStatus.BAD_GATEWAY);
    }
    if (status === 503) {
      return new ApplicationException(ErrorCode.INFRASTRUCTURE_UNAVAILABLE, openai
        ? 'OpenAI đang quá tải. Thử lại sau.'
        : 'VPSTTT AI chưa có tài khoản tạo ảnh khả dụng. Thử lại sau.', HttpStatus.SERVICE_UNAVAILABLE);
    }
    return new ApplicationException(ErrorCode.INFRASTRUCTURE_UNAVAILABLE, `Không tạo được ảnh bằng ${this.label} (mất kết nối hoặc quá thời gian).`, HttpStatus.SERVICE_UNAVAILABLE);
  }
}
