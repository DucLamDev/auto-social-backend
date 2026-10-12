import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class StorageService {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly endpoint: string;
  private readonly publicUrl: string;

  constructor(config: ConfigService) {
    this.endpoint = config.get<string>('S3_ENDPOINT', 'http://localhost:9000');
    this.bucket = config.get<string>('S3_BUCKET', 'social-publisher');
    this.publicUrl = config.get<string>(
      'S3_PUBLIC_URL',
      `${this.endpoint.replace(/\/$/, '')}/${this.bucket}`,
    );
    this.client = new S3Client({
      endpoint: this.endpoint,
      region: config.get<string>('S3_REGION', 'us-east-1'),
      forcePathStyle: config.get<string>('S3_FORCE_PATH_STYLE', 'true') === 'true',
      credentials: {
        accessKeyId: config.get<string>('S3_ACCESS_KEY', 'minioadmin'),
        secretAccessKey: config.get<string>('S3_SECRET_KEY', 'change_me'),
      },
    });
  }

  async put(key: string, body: Buffer, contentType: string): Promise<string> {
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }),
    );
    return `${this.publicUrl.replace(/\/$/, '')}/${key.split('/').map(encodeURIComponent).join('/')}`;
  }

  async get(key: string, maxBytes: number): Promise<Buffer> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
      throw new Error('Storage read limit must be a positive safe integer');
    }
    // Fetch one byte past the limit so a missing or inaccurate object metadata
    // value cannot make an oversized object appear acceptable.
    const response = await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Range: `bytes=0-${maxBytes}`,
      }),
    );
    const totalSize = response.ContentRange?.match(/\/(\d+)$/)?.[1];
    if (
      (totalSize && Number(totalSize) > maxBytes) ||
      (response.ContentLength !== undefined && response.ContentLength > maxBytes)
    ) {
      await response.Body?.transformToByteArray().catch(() => undefined);
      throw new Error('Stored object exceeds the requested read limit');
    }
    if (!response.Body) throw new Error('Stored object has no body');
    const body = Buffer.from(await response.Body.transformToByteArray());
    if (body.length > maxBytes) {
      body.fill(0);
      throw new Error('Stored object exceeds the requested read limit');
    }
    return body;
  }
}
