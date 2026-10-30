/** A provider's review queue is distinct from a permalink to an individual post. */
export function reviewDestination(settings: Record<string, unknown>): {
  reviewUrl?: string;
  reviewUrlKind?: 'pending_queue' | 'platform';
} {
  for (const value of [settings.extensionTargetUrl, settings.baseUrl, settings.manualUrl]) {
    if (typeof value !== 'string') continue;
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' || url.username || url.password) continue;
      url.search = ''; url.hash = '';
      if (settings.extensionEngine === 'discourse') {
        // Keep a subfolder installation (e.g. /community/forums). /my resolves
        // to the signed-in user, including sites using a different SSO handle.
        const base = url.pathname.replace(/\/(?:new-topic|latest|categories|c|t|u|my)(?:\/.*)?$/, '').replace(/\/$/, '');
        url.pathname = `${base}/my/activity/pending`;
        return { reviewUrl: url.href, reviewUrlKind: 'pending_queue' };
      }
      url.pathname = url.pathname.replace(/\/(?:new-topic|latest|categories)\/?$/, '/') || '/';
      return { reviewUrl: url.href, reviewUrlKind: 'platform' };
    } catch { /* Omit invalid destinations without exposing account settings. */ }
  }
  return {};
}
