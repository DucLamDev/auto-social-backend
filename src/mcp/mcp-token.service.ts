import { BadRequestException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { RoleName } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { sha256 } from '../common/utils/crypto.utils';
import { PrismaService } from '../database/prisma.service';

export const MCP_TOKEN_PREFIX = 'mcp_';
export const MCP_SCOPES = ['read', 'write'] as const;
export type McpScope = (typeof MCP_SCOPES)[number];

/** Who is calling the MCP endpoint; roles are reloaded on every request. */
export interface McpPrincipal {
  tokenId: string;
  ownerId: string;
  roles: RoleName[];
  scopes: McpScope[];
}

const LAST_USED_WRITE_INTERVAL_MS = 30_000;
const MAX_NAME_LENGTH = 80;
const MAX_EXPIRY_DAYS = 365;

/** A new random token and the hash that is stored; the plaintext is shown once. */
export function newMcpToken(): { token: string; tokenHash: string } {
  const token = `${MCP_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
  return { token, tokenHash: sha256(token) };
}

function isScope(value: string): value is McpScope {
  return (MCP_SCOPES as readonly string[]).includes(value);
}

@Injectable()
export class McpTokenService {
  constructor(private readonly prisma: PrismaService) {}

  async issue(ownerId: string, name: string, options: { readOnly?: boolean; expiresInDays?: number } = {}) {
    const label = name.trim();
    if (!label || label.length > MAX_NAME_LENGTH) throw new BadRequestException(`Token name must be 1-${MAX_NAME_LENGTH} characters`);
    const days = options.expiresInDays;
    if (days !== undefined && (!Number.isSafeInteger(days) || days < 1 || days > MAX_EXPIRY_DAYS)) {
      throw new BadRequestException(`expiresInDays must be 1-${MAX_EXPIRY_DAYS}`);
    }
    const { token, tokenHash } = newMcpToken();
    const created = await this.prisma.mcpToken.create({
      data: {
        ownerId,
        name: label,
        tokenHash,
        scopes: options.readOnly ? ['read'] : ['read', 'write'],
        expiresAt: days ? new Date(Date.now() + days * 86_400_000) : null,
      },
      select: { id: true, name: true, scopes: true, expiresAt: true, createdAt: true },
    });
    return { ...created, token };
  }

  list(ownerId: string) {
    return this.prisma.mcpToken.findMany({
      where: { ownerId },
      select: { id: true, name: true, scopes: true, lastUsedAt: true, expiresAt: true, revokedAt: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  async revoke(ownerId: string, id: string) {
    const result = await this.prisma.mcpToken.updateMany({ where: { id, ownerId, revokedAt: null }, data: { revokedAt: new Date() } });
    if (!result.count) throw new NotFoundException('MCP token not found');
    return { revoked: true };
  }

  async authenticate(authorization: string | undefined): Promise<McpPrincipal> {
    const token = authorization?.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
    if (!token.startsWith(MCP_TOKEN_PREFIX) || token.length > 128) throw new UnauthorizedException('A valid MCP bearer token is required');
    const row = await this.prisma.mcpToken.findUnique({
      where: { tokenHash: sha256(token) },
      include: { owner: { select: { enabled: true, roles: { select: { role: { select: { name: true } } } } } } },
    });
    if (!row || row.revokedAt || (row.expiresAt && row.expiresAt.getTime() <= Date.now()) || !row.owner.enabled) {
      throw new UnauthorizedException('The MCP token is invalid, expired or revoked');
    }
    if (!row.lastUsedAt || Date.now() - row.lastUsedAt.getTime() >= LAST_USED_WRITE_INTERVAL_MS) {
      // Bookkeeping only: a failed write must not reject an authenticated call.
      await this.prisma.mcpToken.update({ where: { id: row.id }, data: { lastUsedAt: new Date() } }).catch(() => undefined);
    }
    return {
      tokenId: row.id,
      ownerId: row.ownerId,
      roles: row.owner.roles.map((entry) => entry.role.name),
      scopes: row.scopes.filter(isScope),
    };
  }
}
