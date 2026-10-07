import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';

@Injectable()
export class PlatformsService {
  constructor(private readonly prisma: PrismaService) {}

  list() {
    return this.prisma.platform.findMany({
      include: { capability: true, _count: { select: { accounts: true } } },
      orderBy: { name: 'asc' },
    });
  }

  get(slug: string) {
    return this.prisma.platform.findUniqueOrThrow({
      where: { slug },
      include: { capability: true, _count: { select: { accounts: true } } },
    });
  }

  setEnabled(slug: string, enabled: boolean) {
    return this.prisma.platform.update({ where: { slug }, data: { enabled }, include: { capability: true } });
  }
}
