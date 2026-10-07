import { BadRequestException, Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { OAuthStateStatus } from '@prisma/client';
import { sha256 } from '../common/utils/crypto.utils';
import { PrismaService } from '../database/prisma.service';

@Injectable()
export class OAuthStateService {
  constructor(private readonly prisma: PrismaService) {}

  async create(userId: string, provider: string, redirectUri: string) {
    const state = randomBytes(32).toString('base64url');
    await this.prisma.oAuthState.create({
      data: { userId, provider, redirectUri, stateHash: sha256(state), expiresAt: new Date(Date.now() + 10 * 60_000) },
    });
    return { state };
  }

  async consume(provider: string, state: string) {
    const entry = await this.prisma.oAuthState.findUnique({ where: { stateHash: sha256(state) } });
    if (!entry || entry.provider !== provider || entry.status !== OAuthStateStatus.PENDING || entry.expiresAt <= new Date()) {
      throw new BadRequestException('OAuth state is invalid, expired, or already used');
    }
    const updated = await this.prisma.oAuthState.updateMany({
      where: { id: entry.id, status: OAuthStateStatus.PENDING },
      data: { status: OAuthStateStatus.CONSUMED, consumedAt: new Date() },
    });
    if (!updated.count) throw new BadRequestException('OAuth state was already consumed');
    return entry;
  }
}
