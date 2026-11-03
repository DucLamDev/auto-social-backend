import { UnauthorizedException } from '@nestjs/common';
import { sha256 } from '../common/utils/crypto.utils';
import { PrismaService } from '../database/prisma.service';
import { MCP_TOKEN_PREFIX, McpTokenService } from './mcp-token.service';

function setup(row?: Record<string, unknown>) {
  const prisma = {
    mcpToken: {
      create: jest.fn((args: { data: Record<string, unknown> }) => Promise.resolve({ id: 'token-1', name: args.data.name, scopes: args.data.scopes, expiresAt: args.data.expiresAt, createdAt: new Date() })),
      findUnique: jest.fn().mockResolvedValue(row ?? null),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findMany: jest.fn().mockResolvedValue([]),
    },
  };
  return { prisma, service: new McpTokenService(prisma as unknown as PrismaService) };
}

const activeRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'token-1', ownerId: 'owner-1', scopes: ['read', 'write', 'bogus'], revokedAt: null, expiresAt: null, lastUsedAt: null,
  owner: { enabled: true, roles: [{ role: { name: 'EDITOR' } }] }, ...overrides,
});

describe('McpTokenService', () => {
  it('stores only the SHA-256 of a new token and returns the plaintext once', async () => {
    const { prisma, service } = setup();
    const created = await service.issue('owner-1', ' codex ', { readOnly: true, expiresInDays: 30 });
    expect(created.token.startsWith(MCP_TOKEN_PREFIX)).toBe(true);
    const data = (prisma.mcpToken.create.mock.calls[0] as [{ data: Record<string, unknown> }])[0].data;
    expect(data).toMatchObject({ ownerId: 'owner-1', name: 'codex', tokenHash: sha256(created.token), scopes: ['read'] });
    expect(JSON.stringify(data)).not.toContain(created.token);
    expect(data.expiresAt).toBeInstanceOf(Date);
  });

  it('rejects an empty name and an out-of-range expiry', async () => {
    const { service } = setup();
    await expect(service.issue('owner-1', '  ')).rejects.toThrow('Token name');
    await expect(service.issue('owner-1', 'codex', { expiresInDays: 400 })).rejects.toThrow('expiresInDays');
  });

  it('authenticates an active token with the owner roles and known scopes only', async () => {
    const { prisma, service } = setup(activeRow());
    const principal = await service.authenticate(`Bearer ${MCP_TOKEN_PREFIX}abc`);
    expect(principal).toEqual({ tokenId: 'token-1', ownerId: 'owner-1', roles: ['EDITOR'], scopes: ['read', 'write'] });
    expect(prisma.mcpToken.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { tokenHash: sha256(`${MCP_TOKEN_PREFIX}abc`) } }));
    expect(prisma.mcpToken.update).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['no header', undefined, activeRow()],
    ['another token type', 'Bearer spx_device-token', activeRow()],
    ['unknown token', `Bearer ${MCP_TOKEN_PREFIX}abc`, undefined],
    ['revoked token', `Bearer ${MCP_TOKEN_PREFIX}abc`, activeRow({ revokedAt: new Date() })],
    ['expired token', `Bearer ${MCP_TOKEN_PREFIX}abc`, activeRow({ expiresAt: new Date(Date.now() - 1_000) })],
    ['disabled owner', `Bearer ${MCP_TOKEN_PREFIX}abc`, activeRow({ owner: { enabled: false, roles: [] } })],
  ])('refuses %s', async (_case, header, row) => {
    const { service } = setup(row);
    await expect(service.authenticate(header)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('writes lastUsedAt at most every 30 seconds', async () => {
    const { prisma, service } = setup(activeRow({ lastUsedAt: new Date(Date.now() - 5_000) }));
    await service.authenticate(`Bearer ${MCP_TOKEN_PREFIX}abc`);
    expect(prisma.mcpToken.update).not.toHaveBeenCalled();
  });

  it('revokes only an active token of the same owner', async () => {
    const { prisma, service } = setup();
    await service.revoke('owner-1', 'token-1');
    expect(prisma.mcpToken.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'token-1', ownerId: 'owner-1', revokedAt: null } }));
    prisma.mcpToken.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(service.revoke('owner-1', 'other')).rejects.toThrow('not found');
  });
});
