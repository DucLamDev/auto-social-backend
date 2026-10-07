import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { UpsertPromptDto } from './dto/upsert-prompt.dto';

@Injectable()
export class PromptsService {
  constructor(private readonly prisma: PrismaService) {}

  list() {
    return this.prisma.promptTemplate.findMany({ include: { platform: { select: { slug: true, name: true } } }, orderBy: [{ platformId: 'asc' }, { version: 'desc' }] });
  }

  async createVersion(dto: UpsertPromptDto) {
    const platform = await this.prisma.platform.findUniqueOrThrow({ where: { slug: dto.platformSlug } });
    const latest = await this.prisma.promptTemplate.aggregate({ where: { platformId: platform.id, name: dto.name }, _max: { version: true } });
    return this.prisma.$transaction(async (transaction) => {
      if (dto.active ?? true) await transaction.promptTemplate.updateMany({ where: { platformId: platform.id, name: dto.name, active: true }, data: { active: false } });
      return transaction.promptTemplate.create({
        data: {
          platformId: platform.id,
          name: dto.name,
          systemPrompt: dto.systemPrompt,
          userTemplate: dto.userTemplate,
          schema: (dto.schema ?? {}) as Prisma.InputJsonObject,
          version: (latest._max.version ?? 0) + 1,
          active: dto.active ?? true,
        },
      });
    });
  }
}
