// Local read-only diagnostics: structural markers only, never field values,
// cookies, general web storage, full page text, auth headers, URL queries or fragments.
// Only the extension's own publish receipt status is included from sessionStorage.
// Extension task metadata excludes payloads, credentials and pairing tokens.
async function inspect() {
  const origin = new URL(new URL(location.href).searchParams.get('origin')).origin;
  document.title = `VPSTTT login diagnostics ${new URL(origin).hostname}`;
  if (!await chrome.permissions.contains({ origins: [`${origin}/*`] })) {
    document.getElementById('result').textContent = JSON.stringify({ origin, version: chrome.runtime.getManifest().version, error: 'Origin permission is missing', granted: (await chrome.permissions.getAll()).origins });
    return;
  }
  let tabs = await chrome.tabs.query({ url: origin === 'https://www.quora.com' ? 'https://*.quora.com/*' : `${origin}/*` });
  if (!tabs.length && new URL(location.href).searchParams.get('open') === '1') {
    const created = await chrome.tabs.create({ url: origin, active: false });
    for (let i = 0; i < 20; i++) {
      await new Promise(resolve => setTimeout(resolve, 300));
      const current = await chrome.tabs.get(created.id);
      if (current.status === 'complete') break;
    }
    tabs = [await chrome.tabs.get(created.id)];
  }
  const results = [];
  for (const tab of tabs) {
    let timer;
    try {
      const pageOrigin = new URL(tab.url).origin;
      if (!await chrome.permissions.contains({ origins: [`${pageOrigin}/*`] })) { results.push({ tabId: tab.id, origin: pageOrigin, error: 'Redirected origin permission is missing' }); continue; }
      const prepareQuora = origin === 'https://www.quora.com' && new URL(location.href).searchParams.get('prepareQuora') === '1';
      const [{ result }] = await Promise.race([chrome.scripting.executeScript({ target: { tabId: tab.id }, injectImmediately: true, args: [prepareQuora], func: async (prepareQuora) => {
        const visible = n => n.getClientRects().length > 0 && getComputedStyle(n).visibility !== 'hidden';
        const safe = value => String(value || '').replace(/[\w.+-]+@[\w.-]+/g, '[email]').replace(/[A-Za-z0-9_-]{30,}/g, '[opaque]').slice(0, 100);
        const info = n => ({ tag: n.tagName, role: n.getAttribute('role'), label: safe(n.getAttribute('aria-label')), testid: n.getAttribute('data-testid'), class: safe(n.className), text: safe(n.innerText || n.getAttribute('aria-label') || n.getAttribute('alt')), path: n.href ? safe(new URL(n.href).pathname) : undefined });
        // Optional operator probe: opens only the blank Quora composer. Never
        // fills an editor, changes its audience or clicks a publishing action.
        if (prepareQuora && location.hostname === 'www.quora.com') {
          if (![...document.querySelectorAll('[contenteditable="true"]')].some(visible)) {
            const open = [...document.querySelectorAll('button[aria-label="Add question"]:not([aria-haspopup="menu"])')].filter(visible);
            if (open.length === 1) { open[0].click(); await new Promise(resolve => setTimeout(resolve, 600)); }
          }
          const postTab = [...document.querySelectorAll('button,[role="tab"],[role="button"],.q-click-wrapper')].filter(visible).filter(n => n.textContent.trim() === 'Create Post');
          if (postTab.length === 1) { postTab[0].click(); await new Promise(resolve => setTimeout(resolve, 600)); }
        }
        const composer = document.querySelector('#reply-control, .reply-area[role="dialog"]');
        let forumCategories, ownPendingPosts;
        if (composer) {
          try {
            const base = document.querySelector('meta[name="discourse-base-uri"]')?.content || '';
            const response = await fetch(`${base}/site.json`, { credentials: 'same-origin', headers: { 'X-Requested-With': 'XMLHttpRequest' }, signal: AbortSignal.timeout(5000) });
            const site = await response.json();
            forumCategories = site.categories?.map(c => ({ id: c.id, name: c.name, slug: c.slug, parent: c.parent_category_id, permission: c.permission, minimumRequiredTags: c.minimum_required_tags })).slice(0, 100);
            const session = await fetch(`${base}/session/current.json`, { credentials: 'same-origin', headers: { 'X-Requested-With': 'XMLHttpRequest' }, signal: AbortSignal.timeout(3000) });
            const user = session.ok ? (await session.json()).current_user : null;
            if (user?.username) {
              const pending = await fetch(`${base}/posts/${encodeURIComponent(user.username)}/pending.json`, { credentials: 'same-origin', headers: { 'X-Requested-With': 'XMLHttpRequest' }, signal: AbortSignal.timeout(3000) });
              const payload = pending.ok ? await pending.json() : null;
              ownPendingPosts = { status: pending.status, username: safe(user.username), url: `${location.origin}${base}/my/activity/pending`, count: payload?.pending_posts?.length, titles: payload?.pending_posts?.map(p => safe(p.title || p.payload?.title)) };
            }
          } catch { /* DOM diagnostics remain available. */ }
        }
        let ownProfile;
        if (location.hostname === 'pixelfed.social') {
          try {
            const r = await fetch('/api/pixelfed/v1/accounts/verify_credentials', { credentials: 'same-origin', signal: AbortSignal.timeout(4000) });
            const p = r.ok ? await r.json() : null;
            ownProfile = { status: r.status, username: safe(p?.username), id: p?.id };
          } catch { /* Read-only diagnostics. */ }
        }
        let postingProbe;
        const probePath = ({ 'www.cloudpanelforum.org': '/forums/cp-questions/post-thread', 'forum.directadmin.com': '/forums/general-technical-discussion-troubleshooting.32/post-thread', 'dev.to': '/new' })[location.hostname];
        if (probePath) {
          try {
            const r = await fetch(probePath, { credentials: 'same-origin', signal: AbortSignal.timeout(4500) });
            const doc = new DOMParser().parseFromString(await r.text(), 'text/html');
            postingProbe = { status: r.status, path: new URL(r.url).pathname, title: safe(doc.querySelector('h1')?.textContent),
              suspended: /your account has been suspended/i.test(doc.body?.textContent || ''),
              hasTitle: !!doc.querySelector('form[action$="/post-thread"] input[name="title"],form[action$="/post-thread"] textarea[name="title"]'),
              hasBody: !!doc.querySelector('form[action$="/post-thread"] textarea[name="message"]'),
              ownUsername: safe(doc.querySelector('.p-navgroup-link--user .p-navgroup-linkText')?.textContent),
              errors: [...doc.querySelectorAll('.blockMessage,.block-row,.block-body,.formRow-explain')].filter(n => /permission|privilege|confirm|pending|not have|account.*(?:disabled|suspended|verif)/i.test(n.textContent)).slice(0, 6).map(n => safe(n.textContent?.trim())) };
          } catch { postingProbe = { error: 'Read-only posting form probe failed' }; }
        }
        return { origin: location.origin, path: safe(location.pathname), ready: document.readyState, title: safe(document.title), ownProfile, postingProbe,
          forumCategories, ownPendingPosts,
          publishNotice: document.getElementById('vpsttt-publish-notice')?.dataset.status,
          publishReceipts: Object.keys(sessionStorage).filter(k => /^vpsttt:discourse-submit:[a-f0-9-]{36}$/.test(k)).map(k => { try { const r = JSON.parse(sessionStorage.getItem(k)); return { jobId: k.slice('vpsttt:discourse-submit:'.length), status: r.status }; } catch { return { status: 'unreadable' }; } }),
          composerControls: composer ? [...composer.querySelectorAll('button,input,textarea,[contenteditable],.select-kit-header')].filter(visible).map(n => ({ tag: n.tagName, id: n.id, class: safe(n.className), type: n.type, role: n.getAttribute('role'), label: safe(n.getAttribute('aria-label')), title: safe(n.getAttribute('title')), rich: n.getAttribute('data-rich-editor'), checked: n.getAttribute('aria-checked'), text: n.matches('button,.select-kit-header') ? safe(n.innerText) : undefined })) : undefined,
          ownBootstrap: location.hostname === 'dev.to' ? (() => { try { const u = JSON.parse(document.body.getAttribute('data-user') || 'null'); return { present: !!u, username: safe(u?.username) }; } catch { return { present: false }; } })() : undefined,
          editors: [...document.querySelectorAll('textarea,[contenteditable="true"]')].filter(visible).map(n => ({ tag: n.tagName, id: n.id, class: safe(n.className), role: n.getAttribute('role'), characters: (n.value ?? n.innerText ?? '').length, placeholder: safe(n.getAttribute('placeholder') || n.getAttribute('data-placeholder')), ancestors: [n.parentElement, n.parentElement?.parentElement, n.parentElement?.parentElement?.parentElement].filter(Boolean).map(p => ({ tag: p.tagName, role: p.getAttribute('role'), class: safe(p.className) })) })),
          quoraComposer: location.hostname === 'www.quora.com' ? { dialogs: [...document.querySelectorAll('[role="dialog"],.qu-modal')].filter(visible).map(n => ({ tag: n.tagName, role: n.getAttribute('role'), class: safe(n.className) })), tabs: [...document.querySelectorAll('button,[role="tab"],[role="button"],.q-click-wrapper')].filter(visible).filter(n => ['Create Post', 'Add Question', 'Everyone', 'Post'].includes(n.textContent.trim())).map(n => ({ ...info(n), selected: n.getAttribute('aria-selected'), test: n.getAttribute('data-test-id'), parent: { tag: n.parentElement?.tagName, role: n.parentElement?.getAttribute('role'), class: safe(n.parentElement?.className) } })) } : undefined,
          alerts: [...document.querySelectorAll('[role="alert"],.alert-danger,.error-message,.notification-bar')].filter(visible).map(n => safe(n.innerText)),
          postLinks: [...document.querySelectorAll('a[href*="/newsfeed/"]')].filter(n => /\/newsfeed\/\d+/.test(n.getAttribute('href'))).slice(0, 2).map(n => ({ ...info(n), parent: n.parentElement ? info(n.parentElement) : null })),
          pageIssues: ['access denied', 'forbidden', 'verify you are human', 'enable javascript', 'temporarily unavailable', 'not available in your region', 'too many requests'].filter(message => document.body?.innerText?.toLowerCase().includes(message)),
          frames: [...document.querySelectorAll('iframe[src]')].map(frame => { try { return { origin: new URL(frame.src).origin, title: safe(frame.title) }; } catch { return {}; } }),
          accountMenuLinks: [...document.querySelectorAll('.dropdown:has(> .avatar) a[href]')].map(n => ({ ...info(n), visible: visible(n) })),
          authLinks: [...document.querySelectorAll('a[href]')].filter(visible).filter(n => /\/(?:login|sign[-_]?in|auth|oauth|account|settings)(?:\/|$)/i.test(new URL(n.href).pathname)).slice(0, 25).map(info),
          selfLinks: [...document.querySelectorAll('header a[href], nav a[href], [role=menu] a[href], .puppeteer_popper_content a[href], .p-navgroup a[href], .s-topbar a[href], #current-user a[href], [data-testid=profile-link]')].filter(visible).filter(n => /\/profile\/|\/u\/|\/users\/|\/@|\/settings|\/account|\/blog\//.test(new URL(n.href).pathname)).slice(0, 35).map(info),
          navigation: [...document.querySelectorAll('header button,nav button,[role=navigation] button,header img,nav img,[role=navigation] img,[role=button][aria-label],header a[href],nav a[href],aside a[href]')].filter(visible).slice(0, 35).map(n => ({ ...info(n), parent: n.parentElement ? info(n.parentElement) : null, grandparent: n.parentElement?.parentElement ? info(n.parentElement.parentElement) : null,
            control: n.closest('a,button,[role=button],[role=link]') ? info(n.closest('a,button,[role=button],[role=link]')) : null })),
          topControls: [...document.querySelectorAll('button,[role=button],img,[aria-haspopup],[tabindex]')].filter(visible).filter(n => n.getBoundingClientRect().y >= 0 && n.getBoundingClientRect().y < 120).slice(0, 30).map(n => ({ ...info(n), alt: safe(n.getAttribute('alt')), expanded: n.getAttribute('aria-expanded'), haspopup: n.getAttribute('aria-haspopup'), parent: n.parentElement ? info(n.parentElement) : null })),
          buttons: [...document.querySelectorAll('button,[role=button],input[type=submit]')].filter(visible).slice(0, 35).map(n => ({ ...info(n), disabled: n.disabled || n.getAttribute('aria-disabled') === 'true' })),
          inputs: [...document.querySelectorAll('input')].filter(visible).map(n => ({ type: n.type, name: n.name, id: n.id, autocomplete: n.autocomplete, filled: Boolean(n.value), invalid: n.getAttribute('aria-invalid'),
            validation: (n.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean).map(id => safe(document.getElementById(id)?.innerText).replace(/\b\d{6,}\b/g, '[code]')) })),
        };
      } }), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Probe timed out')), 8000); })]);
      results.push({ tabId: tab.id, ...result });
    } catch (error) { results.push({ tabId: tab.id, error: error.message }); }
    finally { clearTimeout(timer); }
  }
  if (origin === 'https://differ.blog' && tabs.length) {
    const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: tabs.at(-1).id }, func: async () => {
      const r = await fetch('/me', { credentials: 'same-origin', signal: AbortSignal.timeout(6000) });
      const doc = new DOMParser().parseFromString(await r.text(), 'text/html');
      const safe = v => String(v || '').replace(/[\w.+-]+@[\w.-]+/g, '[email]').slice(0, 100);
      return { ownProfile: { status: r.status, path: new URL(r.url).pathname,
        headings: [...doc.querySelectorAll('h1,h2')].slice(0, 5).map(n => safe(n.textContent)),
        links: [...doc.querySelectorAll('a[href^="/@"],link[rel="canonical"]')].slice(0, 8).map(n => ({ tag: n.tagName, class: n.className, text: safe(n.textContent), parent: n.parentElement?.className, grandparent: n.parentElement?.parentElement?.className, path: new URL(n.getAttribute('href'), location.origin).pathname })) } };
    } });
    results.push({ tabId: tabs.at(-1).id, ...result });
  }
  if (origin === 'https://www.quora.com' && tabs.length && new URL(location.href).searchParams.get('dryRunQuora') === '1') {
    const { checkQuoraComposer } = await import('./quora-dry-run.js');
    results.push({ tabId: tabs.at(-1).id, quoraDryRun: await checkQuoraComposer(tabs.at(-1).id) });
  }
  const { tasks = {} } = await chrome.storage.session.get('tasks');
  const { paused, lastHeartbeat, loginChecksOnly = false } = await chrome.storage.local.get(['paused', 'lastHeartbeat', 'loginChecksOnly']);
  let workerResponding = false;
  try { workerResponding = !!await Promise.race([chrome.runtime.sendMessage({ type: 'state' }), new Promise(resolve => setTimeout(() => resolve(null), 2500))]); } catch { /* Report the missing worker without private error data. */ }
  results.unshift({ tabId: null, version: chrome.runtime.getManifest().version, paused: !!paused, loginChecksOnly, workerResponding, heartbeatAt: lastHeartbeat?.at, activeTasks: Object.values(tasks).map(task => ({
    id: task.job.jobId, platform: task.job.account.platform, kind: task.job.kind, phase: task.phase,
    tabId: task.tabId, authTabId: task.authTabId, deadline: task.authDeadline, steps: Object.keys(task.authSteps || {}),
  })) });
  document.getElementById('result').textContent = JSON.stringify(results);
}
inspect().catch(error => { document.getElementById('result').textContent = error.message; });
