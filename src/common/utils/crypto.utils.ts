import { createHash } from 'node:crypto';

export const sha256 = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex');

export const stableIdempotencyKey = (...parts: string[]): string => sha256(parts.join(':'));
