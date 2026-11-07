// Injected by value into the destination tab when a composer control was not
// found. Keep every helper inside each function: modules are not in page scope.

/**
 * Describes up to `max` visible controls so the backend AI can say which one is
 * the missing title / body / submit / opener. Never reads what is typed in a
 * field, never includes password, hidden or file inputs, and masks emails,
 * long tokens and long digit runs in labels.
 */
export function collectUiCandidates({ missing = [], max = 60, mode = 'composer' } = {}) {
  const roots = [document];
  for (let i = 0; i < roots.length; i++) for (const node of roots[i].querySelectorAll('*')) if (node.shadowRoot) roots.push(node.shadowRoot);
  const visible = node => {
    if (!node.getClientRects().length) return false;
    const style = getComputedStyle(node);
    return style.visibility !== 'hidden' && style.display !== 'none';
  };
  const safe = (value, limit = 100) => {
    if (value === undefined || value === null) return undefined;
    const text = String(value)
      .replace(/\p{Cc}+/gu, ' ')
      .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '[email]')
      .replace(/\S{30,}/g, '[…]')
      .replace(/\d{6,}/g, '[số]')
      .replace(/\s+/g, ' ')
      .trim();
    return text ? text.slice(0, limit) : undefined;
  };
  const skippedInputTypes = new Set(['password', 'hidden', 'file', 'checkbox', 'radio', 'range', 'color', 'image', 'reset']);
  const auth = mode === 'auth';
  const wantLinks = auth || missing.includes('opener');
  // A sign-in page never needs its fields described (and never their values): only the
  // controls, avatars and short texts that show who is signed in or how to sign in.
  const query = auth
    ? ['a[href]', 'button', '[role="button"]', '[role="menuitem"]', 'img[alt]', 'h1', 'h2', 'h3', 'h4', 'strong', 'b', 'span', 'p'].join(', ')
    : ['input', 'textarea', '[contenteditable=""]', '[contenteditable="true"]', '[role="textbox"]', 'button', '[role="button"]', ...(wantLinks ? ['a[href]'] : [])].join(', ');
  const regionOf = node => {
    if (node.closest('[role="menu"], [role="listbox"], [role="dialog"], dialog[open], .dropdown-menu')) return 'menu';
    if (node.closest('header, [role="banner"], [class*="header" i], [class*="topbar" i], [class*="navbar" i], [id*="header" i]')) return 'header';
    if (node.closest('nav, [role="navigation"]')) return 'nav';
    if (node.closest('aside, [role="complementary"], [class*="sidebar" i], [class*="side-bar" i], [class*="profile-card" i]')) return 'aside';
    return 'main';
  };
  const inArticle = node => Boolean(node.closest('article, [role="article"], [role="feed"], [itemprop="comment"], [class*="comment" i], [class*="feed-item" i], [class*="post-item" i], .c-mw-post'));
  const ownText = node => [...node.childNodes].filter(child => child.nodeType === 3).map(child => child.textContent).join(' ').replace(/\s+/g, ' ').trim();
  const dialogs = roots.flatMap(root => [...root.querySelectorAll('[role="dialog"], dialog[open], .modal.show')]).filter(visible);
  const inDialog = node => dialogs.some(dialog => dialog.contains(node));

  const kindOf = node => {
    const tag = node.tagName.toLowerCase();
    if (tag === 'textarea') return 'textarea';
    if (tag === 'input') {
      const type = (node.getAttribute('type') || 'text').toLowerCase();
      if (skippedInputTypes.has(type)) return null;
      return type === 'submit' ? 'submit' : type === 'button' ? 'button' : 'input';
    }
    if (node.isContentEditable && ['', 'true'].includes(node.getAttribute('contenteditable'))) return 'contenteditable';
    if (node.getAttribute('role') === 'textbox') return 'textbox';
    if (tag === 'button') return node.getAttribute('type') === 'submit' ? 'submit' : 'button';
    if (node.getAttribute('role') === 'button' || (auth && node.getAttribute('role') === 'menuitem')) return 'button';
    if (tag === 'a') return 'link';
    if (auth && tag === 'img') return node.getAttribute('alt')?.trim() && !node.closest('a[href], button, [role="button"]') ? 'image' : null;
    // A short own text (a name, a handle) outside any link or button.
    if (auth) { const own = ownText(node); return own.length >= 2 && own.length <= 40 && !node.closest('a[href], button, [role="button"]') ? 'text' : null; }
    return null;
  };
  const labelOf = node => {
    const byIds = (node.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean)
      .map(id => node.getRootNode().getElementById?.(id)?.textContent || '').join(' ');
    return node.getAttribute('aria-label') || byIds || [...(node.labels ?? [])].map(label => label.textContent).join(' ') || node.getAttribute('title') || (node.tagName === 'IMG' ? node.getAttribute('alt') : '') || '';
  };
  const stableId = id => Boolean(id) && id.length <= 60 && !/\d{3,}|ember\d+|[a-f0-9]{8,}|^:r|^radix-/i.test(id);
  const quote = value => `"${value.replace(/["\\]/g, '\\$&')}"`;
  const cssPath = node => {
    const root = node.getRootNode();
    const unique = selector => { try { return root.querySelectorAll(selector).length === 1; } catch { return false; } };
    const tag = node.tagName.toLowerCase();
    if (stableId(node.id) && unique(`#${CSS.escape(node.id)}`)) return `#${CSS.escape(node.id)}`;
    for (const attribute of ['name', 'data-testid', 'aria-label', 'placeholder', 'data-placeholder']) {
      const value = node.getAttribute(attribute);
      if (!value || value.length > 60 || /\d{4,}/.test(value)) continue;
      const selector = `${tag}[${attribute}=${quote(value)}]`;
      if (unique(selector)) return selector;
    }
    const parts = [];
    for (let current = node, depth = 0; current?.nodeType === 1 && depth < 8; current = current.parentElement, depth++) {
      if (current !== node && stableId(current.id)) {
        const selector = [`#${CSS.escape(current.id)}`, ...parts].join(' > ');
        return unique(selector) && selector.length <= 300 ? selector : null;
      }
      let part = current.tagName.toLowerCase();
      const parent = current.parentElement;
      if (parent) {
        const same = [...parent.children].filter(child => child.tagName === current.tagName);
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(current) + 1})`;
      }
      parts.unshift(part);
      const selector = parts.join(' > ');
      if (selector.length > 300) return null;
      if (unique(selector)) return selector;
    }
    return null;
  };

  const seen = new Set();
  const found = [];
  for (const root of roots) {
    for (const node of root.querySelectorAll(query)) {
      if (seen.has(node) || !visible(node)) continue;
      seen.add(node);
      const kind = kindOf(node);
      if (!kind) continue;
      // Rich editors nest editable children; describe only the editing host.
      if (kind === 'contenteditable' && node.parentElement?.isContentEditable) continue;
      const clickable = ['button', 'submit', 'link'].includes(kind);
      if (auth) {
        const region = regionOf(node);
        // Texts in the page body (posts, articles) do not tell who is signed in.
        if (kind === 'text' && region === 'main') continue;
        found.push({ node, kind, dialog: inDialog(node), form: Boolean(node.closest('form')), clickable, region, article: inArticle(node) });
        continue;
      }
      found.push({ node, kind, dialog: inDialog(node), form: Boolean(node.closest('form')), clickable });
    }
  }
  // The composer is usually the open dialog or a form: describe those first. The account
  // shows in an opened menu, the header, navigation or sidebar: those first for sign-in.
  const regionRank = { menu: 0, header: 1, nav: 2, aside: 3, main: 4 };
  if (auth) found.sort((a, b) => regionRank[a.region] - regionRank[b.region] || Number(a.article) - Number(b.article));
  else found.sort((a, b) => Number(b.dialog) - Number(a.dialog) || Number(b.form) - Number(a.form));
  const candidates = [];
  for (const item of found) {
    if (candidates.length >= max) break;
    const selector = cssPath(item.node);
    if (!selector) continue;
    const node = item.node;
    candidates.push({
      index: candidates.length,
      kind: item.kind,
      tag: node.tagName.toLowerCase().slice(0, 20),
      type: safe(node.getAttribute('type'), 30),
      role: safe(node.getAttribute('role'), 30),
      label: safe(labelOf(node)),
      placeholder: safe(node.getAttribute('placeholder') || node.getAttribute('data-placeholder') || node.getAttribute('aria-placeholder')),
      // Only buttons and links show their text; editors never reveal content. An avatar
      // link shows its image's alt text; a sign-in text candidate shows its own short text.
      text: item.clickable ? safe(node.innerText || node.value || (auth ? node.querySelector('img[alt]')?.getAttribute('alt') : '')) : item.kind === 'text' ? safe(ownText(node), 60) : undefined,
      name: safe(node.getAttribute('name'), 60),
      id: safe(node.id, 60),
      inDialog: item.dialog,
      inForm: item.form,
      disabled: Boolean(node.disabled) || node.getAttribute('aria-disabled') === 'true',
      ...(auth ? { region: item.region, inArticle: item.article } : {}),
      selector,
    });
  }
  return { url: location.href, candidates: candidates.map(candidate => Object.fromEntries(Object.entries(candidate).filter(([, value]) => value !== undefined))) };
}

/**
 * Keeps only suggested selectors that match exactly one visible element of a
 * plausible kind on this page right now.
 */
export function verifyUiSelectors({ selectors = {} } = {}) {
  const roots = [document];
  for (let i = 0; i < roots.length; i++) for (const node of roots[i].querySelectorAll('*')) if (node.shadowRoot) roots.push(node.shadowRoot);
  const visible = node => node.getClientRects().length > 0 && getComputedStyle(node).visibility !== 'hidden';
  const editable = node => node.matches('textarea, [role="textbox"]') || (node.isContentEditable && ['', 'true'].includes(node.getAttribute('contenteditable')))
    || (node.matches('input') && ['', 'text', 'search'].includes((node.getAttribute('type') || '').toLowerCase()));
  const clickable = node => node.matches('button, [role="button"], input[type="submit"], input[type="button"], a[href]');
  const fits = { title: editable, body: node => editable(node) && !node.matches('input'), submit: node => clickable(node) && !node.matches('a'), opener: clickable };
  const result = {};
  for (const [field, selector] of Object.entries(selectors)) {
    if (!fits[field] || typeof selector !== 'string' || selector.length > 300) continue;
    let matches;
    try { matches = roots.flatMap(root => [...root.querySelectorAll(selector)]).filter(visible); } catch { continue; }
    if (matches.length === 1 && fits[field](matches[0])) result[field] = selector;
  }
  return result;
}

/**
 * Clicks the one element an AI sign-in hint named: the account menu or the
 * sign-in button. Never a form submit, never anything inside a form that holds a
 * password field, and a sign-in click only on a control that says sign in.
 */
export function clickAuthElement({ selector, purpose } = {}) {
  const roots = [document];
  for (let i = 0; i < roots.length; i++) for (const node of roots[i].querySelectorAll('*')) if (node.shadowRoot) roots.push(node.shadowRoot);
  const visible = node => node.getClientRects().length > 0 && getComputedStyle(node).visibility !== 'hidden';
  if (typeof selector !== 'string' || selector.length > 300 || !['accountMenu', 'login'].includes(purpose)) return false;
  let matches;
  try { matches = roots.flatMap(root => [...root.querySelectorAll(selector)]).filter(visible); } catch { return false; }
  if (matches.length !== 1) return false;
  const target = matches[0].closest('a[href], button, [role="button"], [role="menuitem"]') ?? matches[0];
  const label = [target.innerText, target.getAttribute('aria-label'), target.getAttribute('title'), target.querySelector?.('img[alt]')?.getAttribute('alt')].filter(Boolean).join(' ');
  if (target.matches('[type="submit"]') || target.closest('form')?.querySelector('input[type="password"]')) return false;
  if (target.disabled || target.getAttribute('aria-disabled') === 'true') return false;
  if (/log ?out|sign ?out|đăng xuất|delete|xoá|xóa/i.test(label)) return false;
  if (purpose === 'login' && (!/log ?in|sign ?in|google|đăng nhập|connexion|anmelden/i.test(label) || /sign ?up|register|đăng ký/i.test(label))) return false;
  target.click();
  return true;
}
