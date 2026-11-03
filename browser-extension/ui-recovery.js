// Injected by value into the destination tab when a composer control was not
// found. Keep every helper inside each function: modules are not in page scope.

/**
 * Describes up to `max` visible controls so the backend AI can say which one is
 * the missing title / body / submit / opener. Never reads what is typed in a
 * field, never includes password, hidden or file inputs, and masks emails,
 * long tokens and long digit runs in labels.
 */
export function collectUiCandidates({ missing = [], max = 60 } = {}) {
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
  const wantLinks = missing.includes('opener');
  const query = ['input', 'textarea', '[contenteditable=""]', '[contenteditable="true"]', '[role="textbox"]', 'button', '[role="button"]', ...(wantLinks ? ['a[href]'] : [])].join(', ');
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
    if (node.getAttribute('role') === 'button') return 'button';
    if (tag === 'a') return 'link';
    return null;
  };
  const labelOf = node => {
    const byIds = (node.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean)
      .map(id => node.getRootNode().getElementById?.(id)?.textContent || '').join(' ');
    return node.getAttribute('aria-label') || byIds || [...(node.labels ?? [])].map(label => label.textContent).join(' ') || node.getAttribute('title') || '';
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
      found.push({ node, kind, dialog: inDialog(node), form: Boolean(node.closest('form')), clickable });
    }
  }
  // The composer is usually the open dialog or a form: describe those first.
  found.sort((a, b) => Number(b.dialog) - Number(a.dialog) || Number(b.form) - Number(a.form));
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
      // Only buttons and links show their text; editors never reveal content.
      text: item.clickable ? safe(node.innerText || node.value) : undefined,
      name: safe(node.getAttribute('name'), 60),
      id: safe(node.id, 60),
      inDialog: item.dialog,
      inForm: item.form,
      disabled: Boolean(node.disabled) || node.getAttribute('aria-disabled') === 'true',
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
