import { RequestMethod } from '@nestjs/common';
import type { GlobalPrefixOptions } from '@nestjs/common/interfaces';

export const GLOBAL_PREFIX = 'api/v1';

/** Routes served at the root: probes and the MCP endpoint for AI agents. */
export const GLOBAL_PREFIX_OPTIONS: GlobalPrefixOptions = {
  exclude: ['health', 'ready', { path: 'mcp', method: RequestMethod.ALL }],
};
