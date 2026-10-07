import { LogLevel } from '@nestjs/common';

export function loggerLevels(value = process.env.LOG_LEVEL ?? 'info'): LogLevel[] {
  switch (value) {
    case 'error': return ['error'];
    case 'warn': return ['error', 'warn'];
    case 'info': return ['error', 'warn', 'log'];
    case 'debug': return ['error', 'warn', 'log', 'debug'];
    case 'verbose': return ['error', 'warn', 'log', 'debug', 'verbose'];
    default: throw new Error('LOG_LEVEL must be error, warn, info, debug, or verbose');
  }
}
