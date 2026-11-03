import { CanActivate, ExecutionContext, ForbiddenException, HttpException, HttpStatus, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { RedisService } from '../queue/redis.service';
import { McpPrincipal, McpTokenService } from './mcp-token.service';

export type McpRequest = Request & { mcp?: McpPrincipal; requestId?: string };

/**
 * Gate for POST /mcp: kill switch, browser-origin check (DNS rebinding),
 * bearer token and a per-token rate limit. Roles are enforced per tool.
 */
@Injectable()
export class McpTokenGuard implements CanActivate {
  constructor(
    private readonly tokens: McpTokenService,
    private readonly config: ConfigService,
    @Optional() private readonly redis?: RedisService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (this.config.get<boolean>('MCP_ENABLED') !== true) throw new NotFoundException();
    const request = context.switchToHttp().getRequest<McpRequest>();
    const origin = request.headers.origin;
    // Agents such as Codex send no Origin. A browser page may only call this
    // endpoint from the dashboard origin.
    if (origin && !this.allowedOrigins().includes(origin)) throw new ForbiddenException('Origin is not allowed to use MCP');
    const principal = await this.tokens.authenticate(request.headers.authorization);
    const limit = Number(this.config.get<number>('MCP_RATE_LIMIT_PER_MINUTE', 60));
    const usage = await this.redis?.consumeRateLimit(`rate_limit:mcp:${principal.tokenId}`, limit, 60);
    if (usage && !usage.allowed) throw new HttpException('MCP rate limit reached. Try again in a minute', HttpStatus.TOO_MANY_REQUESTS);
    request.mcp = principal;
    return true;
  }

  private allowedOrigins(): string[] {
    return (this.config.get<string>('FRONTEND_URL') ?? '').split(',').map((value) => value.trim()).filter(Boolean);
  }
}
