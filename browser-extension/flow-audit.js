// Operator diagnostics restricted to the selected publishing services. No input
// values, credentials, cookies, page bodies, query strings or fragments leave tabs.
const destinations = {
  minds: 'https://www.minds.com/newsfeed/subscriptions', linkedin: 'https://www.linkedin.com/feed/',
  stackoverflow: 'https://stackoverflow.com/questions/ask', serverfault: 'https://serverfault.com/questions/ask', unix: 'https://unix.stackexchange.com/questions/ask',
  lemmy: 'https://lemmy.world/create_post', discuit: 'https://discuit.org/new', huggingface: 'https://huggingface.co/new-blog',
  dzone: 'https://dzone.com/content/article/post.html', differ: 'https://differ.blog/new-story', mewe: 'https://mewe.com', producthunt: 'https://www.producthunt.com',
  dailymotion: 'https://www.dailymotion.com', blogger: 'https://www.blogger.com', ubiquiti: 'https://community.ui.com',
  studio: 'https://studio.dailymotion.com',
  daily: 'https://app.daily.dev', warrior: 'https://www.warriorforum.com', linuxfoundation: 'https://forum.linuxfoundation.org',
};
async function run() {
  const missingPermissions = [];
  const open = new URL(location.href).searchParams.get('open')?.split(',') || [];
  for (const key of open) {
    const url = destinations[key]; if (!url) continue;
    if (!await chrome.permissions.contains({ origins: [new URL(url).origin + '/*'] })) { missingPermissions.push(new URL(url).origin); continue; }
    const existing = await chrome.tabs.query({ url: new URL(url).origin + '/*' });
    if (!existing.some(tab => tab.url.startsWith(url))) await chrome.tabs.create({ url, active: false });
  }
  if (open.length) await new Promise(resolve => setTimeout(resolve, 3000));
  const origins = new Set(Object.values(destinations).map(url => new URL(url).origin));
  const results = [{ tabId: null, version: chrome.runtime.getManifest().version, missingPermissions }];
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.filter(tab => { try { return origins.has(new URL(tab.url).origin); } catch { return false; } }).map(async tab => {
    try {
      if (!await chrome.permissions.contains({ origins: [new URL(tab.url).origin + '/*'] })) return;
      const [{ result }] = await Promise.race([chrome.scripting.executeScript({ target: { tabId: tab.id }, args: [new URL(location.href).searchParams.get('prepare') === '1'], func: async prepare => {
        const visible = n => n.getClientRects().length && getComputedStyle(n).visibility !== 'hidden';
        if (prepare) {
          if (location.hostname === 'dzone.com' && location.pathname === '/content/article/post.html') {
            const more = [...document.querySelectorAll('button.dropdown-toggle')].filter(visible).filter(n => n.innerText.trim() === 'More');
            if (more.length && more[more.length - 1].getAttribute('aria-expanded') !== 'true') { more[more.length - 1].click(); await new Promise(resolve => setTimeout(resolve, 300)); }
          }
          const labels = { 'www.linkedin.com': ['Start a post', 'Bắt đầu bài đăng'], 'dzone.com': ['Post'], 'community.ui.com': ['+ New Post'] }[location.hostname];
          if (labels && ![...document.querySelectorAll('textarea,[contenteditable]')].some(visible)) {
            const opens = [...document.querySelectorAll('button,[role="button"]')].filter(visible).filter(n => labels.includes(n.innerText.trim()));
            if (opens.length === 1) { opens[0].click(); await new Promise(resolve => setTimeout(resolve, 900)); }
          }
        }
        const safe = s => String(s || '').replace(/[\w.+-]+@[\w.-]+/g, '[email]').replace(/[A-Za-z0-9_-]{30,}/g, '[opaque]').slice(0, 100);
        return { origin: location.origin, path: location.pathname,
          workflowControls: location.hostname === 'dzone.com' ? [...document.querySelectorAll('.dropdown-menu [ng-click],button.dropdown-toggle')].map(n => ({tag:n.tagName,text:safe(n.innerText || n.textContent),click:n.getAttribute('ng-click'),shown:!!visible(n)})) : undefined,
          labels: [...document.querySelectorAll('label')].filter(visible).slice(0, 25).map(n => safe(n.innerText)),
          frames: [...document.querySelectorAll('iframe')].filter(visible).map(n => ({ title: safe(n.title), name: safe(n.name), src: n.src ? new URL(n.src).origin + new URL(n.src).pathname : '' })),
          fields: [...document.querySelectorAll('input:not([type="hidden"]),textarea,[contenteditable]:not([contenteditable="false"]),select')].filter(visible).map(n => ({
            tag: n.tagName, type: n.type, id: n.id, name: n.name, class: safe(n.className), label: safe(n.getAttribute('aria-label')), placeholder: safe(n.getAttribute('placeholder') || n.getAttribute('data-placeholder')), role: n.getAttribute('role'),
          })),
          controls: [...document.querySelectorAll('button,[role="button"],input[type="submit"],a[href],a[ng-click],.dropdown-menu a')].filter(visible).filter(n => !n.classList.contains('fr-command')).filter(n => (n.tagName === 'BUTTON' && /new-story|post.html|sharing\/compose/.test(location.pathname)) || /post|write|create|submit|article|question|login|log in|sign in|google|new|publish|blog|launch|đăng|tạo|cộng đồng|hoàn tất/i.test(n.innerText || n.value || n.getAttribute('aria-label') || '')).slice(0, 32).map(n => ({
            tag: n.tagName, text: safe(n.innerText || n.value || n.getAttribute('aria-label')), id: n.id, class: safe(n.className), path: n.href ? new URL(n.href).pathname : undefined, disabled: n.disabled,
          })),
        };
      } }), new Promise((_, reject) => setTimeout(() => reject(new Error('Probe timed out')), 8000))]);
      results.push({ tabId: tab.id, ...result });
    } catch { results.push({ tabId: tab.id, origin: new URL(tab.url).origin, error: 'Cannot inspect tab' }); }
  }));
  document.querySelector('#result').textContent = JSON.stringify(results);
}
run().catch(() => { document.querySelector('#result').textContent = JSON.stringify({ origin: 'audit.local', error: 'Probe failed' }); });
