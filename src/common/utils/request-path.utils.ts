interface RequestPathSource {
  path?: string;
  originalUrl?: string;
  url?: string;
}

/**
 * Return a log-safe request path. OAuth codes, state values, signed URLs, and
 * every other query parameter are deliberately excluded from application logs.
 */
export function requestPathForLog(request: RequestPathSource): string {
  const candidate = request.path ?? request.originalUrl ?? request.url ?? '/';
  const pathname = candidate.split(/[?#]/, 1)[0];
  return pathname || '/';
}
