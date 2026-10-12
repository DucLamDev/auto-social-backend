/**
 * A credential row by itself is not evidence of an authenticated browser
 * session. Playwright can produce an empty storageState for a logged-out
 * context, so require at least one cookie or persisted origin value.
 */
export function hasUsableBrowserStorageState(credentials: Record<string, unknown>): boolean {
  const state = credentials.storageState;
  if (!state || typeof state !== 'object' || Array.isArray(state)) return false;
  const record = state as Record<string, unknown>;
  if (!Array.isArray(record.cookies) || !Array.isArray(record.origins)) return false;
  if (record.cookies.length > 0) return true;
  return record.origins.some((origin) => {
    if (!origin || typeof origin !== 'object' || Array.isArray(origin)) return false;
    const item = origin as Record<string, unknown>;
    return (Array.isArray(item.localStorage) && item.localStorage.length > 0)
      || (Array.isArray(item.indexedDB) && item.indexedDB.length > 0);
  });
}
