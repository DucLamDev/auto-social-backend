import { Controller, Delete, Get, Logger, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Response } from 'express';
import { Public } from '../common/decorators/public.decorator';
import { McpRequest, McpTokenGuard } from './mcp-token.guard';
import { McpToolsService } from './mcp-tools.service';

function methodNotAllowed(response: Response): void {
  response.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed. Use POST.' }, id: null });
}

/**
 * Streamable HTTP MCP endpoint (stateless, JSON responses). Served at /mcp,
 * outside the api/v1 prefix and the OpenAPI document. The JWT guard is
 * skipped; McpTokenGuard authenticates the agent's own bearer token.
 */
@ApiExcludeController()
@Public()
@UseGuards(McpTokenGuard)
@Controller('mcp')
export class McpController {
  private readonly logger = new Logger(McpController.name);

  constructor(private readonly tools: McpToolsService) {}

  @Post()
  async handle(@Req() request: McpRequest, @Res() response: Response): Promise<void> {
    const principal = request.mcp;
    if (!principal) { response.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null }); return; }
    const server = this.tools.createServer({ principal, requestId: request.requestId });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    response.on('close', () => { void transport.close(); void server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(request, response, request.body);
    } catch (error) {
      this.logger.error(`MCP request failed: ${error instanceof Error ? error.message : 'unknown error'}`);
      if (!response.headersSent) response.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
    }
  }

  // Stateless server: no SSE stream to open and no session to delete.
  @Get()
  get(@Res() response: Response): void { methodNotAllowed(response); }

  @Delete()
  remove(@Res() response: Response): void { methodNotAllowed(response); }
}
