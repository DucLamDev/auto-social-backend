import { Injectable } from '@nestjs/common';
import { AccountStatus, PlatformMode, Prisma } from '@prisma/client';
import { CredentialsService } from '../credentials/credentials.service';
import { PrismaService } from '../database/prisma.service';
import { CreatePlatformAccountDto } from './dto/create-platform-account.dto';

const safeAccountSelect = {
  id: true,
  platformId: true,
  name: true,
  username: true,
  externalId: true,
  settings: true,
  enabled: true,
  status: true,
  lastTestedAt: true,
  createdAt: true,
  updatedAt: true,
  platform: { select: { slug: true, name: true, mode: true, availability: true, capability: true } },
  credential: { select: { status: true, expiresAt: true, updatedAt: true } },
  oauthToken: { select: { scopes: true, expiresAt: true, updatedAt: true } },
} satisfies Prisma.PlatformAccountSelect;

@Injectable()
export class PlatformAccountsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly credentials: CredentialsService,
  ) {}

  list(ownerId: string) {
    return this.prisma.platformAccount.findMany({ where: { ownerId }, select: safeAccountSelect, orderBy: { name: 'asc' } });
  }

  get(ownerId: string, id: string) {
    return this.prisma.platformAccount.findFirstOrThrow({ where: { id, ownerId }, select: safeAccountSelect });
  }

  async create(ownerId: string, dto: CreatePlatformAccountDto) {
    const platform = await this.prisma.platform.findUniqueOrThrow({ where: { slug: dto.platformSlug } });
    const account = await this.prisma.platformAccount.create({
      data: {
        ownerId,
        platformId: platform.id,
        name: dto.name.trim(),
        username: dto.username?.trim(),
        externalId: dto.externalId?.trim(),
        settings: (dto.settings ?? {}) as Prisma.InputJsonObject,
        enabled: dto.enabled ?? true,
        status:
          platform.mode === PlatformMode.MANUAL
            ? AccountStatus.CONNECTED
            : AccountStatus.RECONNECT_REQUIRED,
      },
      select: { id: true },
    });
    if (dto.credential) await this.credentials.upsert(account.id, dto.credential);
    return this.get(ownerId, account.id);
  }

  async updateCredential(ownerId: string, id: string, credential: Record<string, unknown>) {
    await this.prisma.platformAccount.findFirstOrThrow({ where: { id, ownerId }, select: { id: true } });
    await this.credentials.upsert(id, credential);
    await this.prisma.platformAccount.update({
      where: { id },
      data: { status: AccountStatus.RECONNECT_REQUIRED, lastTestedAt: null },
    });
    return this.get(ownerId, id);
  }

  async setEnabled(ownerId: string, id: string, enabled: boolean) {
    const account = await this.prisma.platformAccount.findFirstOrThrow({
      where: { id, ownerId },
      include: {
        credential: { select: { id: true } },
        oauthToken: { select: { id: true } },
        platform: { select: { mode: true } },
      },
    });
    const hasValidatedCredential = Boolean(account.credential && account.lastTestedAt);
    const canConnect = account.platform.mode === PlatformMode.MANUAL
      || Boolean(account.oauthToken)
      || hasValidatedCredential;
    const nextStatus = !enabled
      ? AccountStatus.DISABLED
      : canConnect ? AccountStatus.CONNECTED : AccountStatus.RECONNECT_REQUIRED;
    await this.prisma.platformAccount.update({
      where: { id },
      data: {
        enabled,
        status: nextStatus,
      },
    });
    return this.get(ownerId, id);
  }
}
