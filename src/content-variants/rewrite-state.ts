/** A rewrite still "generating" after this long is treated as lost (API restart). */
export const GENERATING_STALE_AFTER_MS = 10 * 60 * 1000;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** A rewrite is running (and not left over from a restart): the draft's text is about to change. */
export function rewriteRunning(aiRevision: unknown): boolean {
  const revision = record(aiRevision);
  const startedAt = typeof revision.startedAt === 'string' ? Date.parse(revision.startedAt) : NaN;
  return revision.status === 'generating' && Date.now() - startedAt < GENERATING_STALE_AFTER_MS;
}
