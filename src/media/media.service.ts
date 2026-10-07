import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { MediaType, Prisma } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import { PrismaService } from '../database/prisma.service';
import { StorageService } from '../storage/storage.service';
import { ListMediaQueryDto } from './dto/list-media-query.dto';
import { paginatedData } from '../common/interceptors/api-response.interceptor';

const MEDIA_FORMATS = new Map<string, { type: MediaType; extension: string; signature: (body: Buffer) => boolean }>([
  ['image/jpeg', { type: MediaType.IMAGE, extension: '.jpg', signature: (body) => body.length >= 3 && body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff }],
  ['image/png', { type: MediaType.IMAGE, extension: '.png', signature: (body) => body.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) }],
  ['image/webp', { type: MediaType.IMAGE, extension: '.webp', signature: (body) => body.subarray(0, 4).toString('ascii') === 'RIFF' && body.subarray(8, 12).toString('ascii') === 'WEBP' }],
  ['video/mp4', { type: MediaType.VIDEO, extension: '.mp4', signature: (body) => body.subarray(4, 8).toString('ascii') === 'ftyp' }],
  ['video/webm', { type: MediaType.VIDEO, extension: '.webm', signature: (body) => body.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) }],
  ['application/pdf', { type: MediaType.DOCUMENT, extension: '.pdf', signature: (body) => body.subarray(0, 5).toString('ascii') === '%PDF-' }],
]);

@Injectable()
export class MediaService {
  constructor(private readonly prisma: PrismaService, private readonly storage: StorageService) {}

  async upload(ownerId: string, file: Express.Multer.File, contentId?: string, variantId?: string) {
    const mimeType = file.mimetype.toLowerCase();
    const format = MEDIA_FORMATS.get(mimeType);
    if (!format) throw new BadRequestException('Unsupported media type');
    if (file.size > 50 * 1024 * 1024) throw new BadRequestException('Media exceeds 50 MiB');
    if (!format.signature(file.buffer)) throw new BadRequestException('Media bytes do not match the declared MIME type');
    if (contentId) {
      const content = await this.prisma.content.findFirstOrThrow({
        where: { id: contentId, ownerId },
        select: { id: true, _count: { select: { campaigns: true } } },
      });
      if (content._count.campaigns) {
        throw new ConflictException('Media cannot be attached after content has been added to a campaign');
      }
    }
    if (variantId) {
      const variant = await this.prisma.contentVariant.findFirstOrThrow({
        where: { id: variantId, content: { ownerId } },
        select: { id: true, _count: { select: { targets: true } } },
      });
      if (variant._count.targets) {
        throw new ConflictException('Media cannot be attached after a variant has been added to a campaign');
      }
    }
    const checksum = createHash('sha256').update(file.buffer).digest('hex');
    const storageKey = `media/${new Date().toISOString().slice(0, 10)}/${randomUUID()}${format.extension}`;
    const publicUrl = await this.storage.put(storageKey, file.buffer, mimeType);
    return this.prisma.mediaAsset.create({
      data: { ownerId, contentId, variantId, type: format.type, storageKey, publicUrl, mimeType, sizeBytes: BigInt(file.size), checksum },
    });
  }

  async list(ownerId: string, query: ListMediaQueryDto) {
    const where: Prisma.MediaAssetWhereInput = {
      ownerId,
      ...(query.contentId ? { contentId: query.contentId } : {}),
      ...(query.variantId ? { variantId: query.variantId } : {}),
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.mediaAsset.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      this.prisma.mediaAsset.count({ where }),
    ]);
    return paginatedData(items, {
      page: query.page,
      limit: query.limit,
      total,
      totalPages: total ? Math.ceil(total / query.limit) : 0,
    });
  }
}
