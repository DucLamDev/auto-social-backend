/**
 * Manage MCP bearer tokens for AI agents (Codex) from the API container:
 *
 *   pnpm mcp:token create --email admin@example.com --name codex [--read-only] [--expires-days 90]
 *   pnpm mcp:token list --email admin@example.com
 *   pnpm mcp:token revoke --email admin@example.com --id <token-id>
 *
 * The token is printed once on create; only its SHA-256 is stored.
 */
import { PrismaService } from '../database/prisma.service';
import { McpTokenService } from './mcp-token.service';

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  const email = option(args, 'email')?.trim().toLowerCase();
  if (!command || !['create', 'list', 'revoke'].includes(command) || !email) {
    console.error('Usage: pnpm mcp:token create|list|revoke --email <owner email> [--name <label>] [--read-only] [--expires-days N] [--id <token id>]');
    process.exitCode = 2;
    return;
  }
  const prisma = new PrismaService();
  try {
    const owner = await prisma.user.findUnique({ where: { email }, select: { id: true, enabled: true } });
    if (!owner?.enabled) throw new Error(`No enabled user ${email}`);
    const tokens = new McpTokenService(prisma);
    if (command === 'create') {
      const days = option(args, 'expires-days');
      const created = await tokens.issue(owner.id, option(args, 'name') ?? 'codex', {
        readOnly: args.includes('--read-only'),
        expiresInDays: days === undefined ? undefined : Number(days),
      });
      console.log(`Token id: ${created.id}\nScopes:   ${created.scopes.join(', ')}\nExpires:  ${created.expiresAt?.toISOString() ?? 'never'}`);
      console.log(`\nMCP token (shown once, store it as AUTO_SOCIAL_MCP_TOKEN on the agent machine):\n${created.token}`);
    } else if (command === 'list') {
      for (const token of await tokens.list(owner.id)) {
        const state = token.revokedAt ? 'revoked' : token.expiresAt && token.expiresAt <= new Date() ? 'expired' : 'active';
        console.log(`${token.id}  ${state.padEnd(7)}  ${token.scopes.join('+').padEnd(10)}  ${token.name}  last used: ${token.lastUsedAt?.toISOString() ?? 'never'}`);
      }
    } else {
      const id = option(args, 'id');
      if (!id) throw new Error('--id is required');
      await tokens.revoke(owner.id, id);
      console.log(`Revoked ${id}`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
