// Injected by value into the destination tab when the composer still has
// required controls the recipe does not know (a community, a language, a rules
// checkbox…). Keep every helper inside each function: modules are not in page scope.

/**
 * Describes up to `max` form controls of the open composer (dialog, or the form
 * holding the body editor) so the backend AI can say how to fill them. Never
 * includes password, email or hidden inputs, the title/body editors, or what is
 * typed in a text field. Custom pickers are opened briefly to read their options.
 */
export async function collectFormControls({ recipe = {}, max = 60 } = {}) {
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const roots = [document];
  for (let i = 0; i < roots.length; i++) for (const node of roots[i].querySelectorAll('*')) if (node.shadowRoot) roots.push(node.shadowRoot);
  const all = selector => roots.flatMap(root => { try { return [...root.querySelectorAll(selector)]; } catch { return []; } });
  const visible = node => {
    if (!node?.getClientRects().length) return false;
    const style = getComputedStyle(node);
    return style.visibility !== 'hidden' && style.display !== 'none';
  };
  const contains = (root, node) => {
    while (node) {
      if (root.contains(node)) return true;
      node = node.getRootNode().host;
    }
    return false;
  };
  const safe = (value, limit = 120) => {
    if (value === undefined || value === null) return undefined;
    const text = String(value)
      .replace(/\p{Cc}+/gu, ' ')
      .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '[email]')
      .replace(/\S{40,}/g, '[…]')
      .replace(/\s+/g, ' ')
      .trim();
    return text ? text.slice(0, limit) : undefined;
  };
  // Option values are often IDs; keep them usable, only drop control characters and emails.
  const optionValue = value => String(value ?? '').replace(/\p{Cc}+/gu, ' ').replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '[email]').trim().slice(0, 120);

  const dialogs = all('[role="dialog"], dialog[open], .modal.show, .compose-modal-component, m-composer__modal').filter(visible);
  const leaves = dialogs.filter(node => !dialogs.some(other => other !== node && contains(node, other)));
  const editors = [...(recipe.titleSelectors ?? []), ...(recipe.bodySelectors ?? [])].flatMap(all).filter(visible);
  const body = (recipe.bodySelectors ?? []).flatMap(all).find(visible);
  const scope = leaves.length === 1 ? leaves[0] : body?.closest('form') ?? document;

  const skippedTypes = new Set(['password', 'email', 'hidden', 'file', 'submit', 'button', 'reset', 'image', 'range', 'color']);
  const kindOf = node => {
    const role = (node.getAttribute('role') || '').toLowerCase();
    const type = (node.getAttribute('type') || '').toLowerCase();
    if (node.tagName === 'SELECT') return 'select';
    if (node.tagName === 'INPUT' && skippedTypes.has(type)) return null;
    if (type === 'checkbox' || role === 'checkbox' || role === 'switch') return 'checkbox';
    if (type === 'radio' || role === 'radio') return 'radio';
    if (role === 'combobox' || node.getAttribute('aria-haspopup') === 'listbox') return 'combobox';
    if (node.tagName === 'TEXTAREA' || node.tagName === 'INPUT') return 'text';
    return null;
  };
  const isPrivate = node => /e-?mail|password|passwd|one-time-code|cc-|credit/i.test(`${node.getAttribute('autocomplete') || ''} ${node.name || ''}`);
  const labelOf = node => {
    const byIds = (node.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean)
      .map(id => node.getRootNode().getElementById?.(id)?.textContent || '').join(' ');
    const wrapping = node.closest('label');
    const own = node.tagName === 'SELECT' ? '' : wrapping ? wrapping.textContent : '';
    return node.getAttribute('aria-label') || byIds || [...(node.labels ?? [])].map(label => label.textContent).join(' ') || own
      || node.getAttribute('placeholder') || node.getAttribute('title') || node.getAttribute('name') || '';
  };
  const stableId = id => Boolean(id) && id.length <= 60 && !/\d{3,}|ember\d+|[a-f0-9]{8,}|^:r|^radix-/i.test(id);
  const quote = text => `"${text.replace(/["\\]/g, '\\$&')}"`;
  const cssPath = node => {
    const root = node.getRootNode();
    const unique = selector => { try { return root.querySelectorAll(selector).length === 1; } catch { return false; } };
    const tag = node.tagName.toLowerCase();
    if (stableId(node.id) && unique(`#${CSS.escape(node.id)}`)) return `#${CSS.escape(node.id)}`;
    for (const attribute of ['name', 'data-testid', 'aria-label', 'placeholder']) {
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
  const checked = node => (node.matches('input') ? node.checked : node.getAttribute('aria-checked') === 'true');
  const invalid = node => node.getAttribute('aria-invalid') === 'true' || [node.getAttribute('aria-errormessage'), ...(node.getAttribute('aria-describedby') || '').split(/\s+/)]
    .filter(Boolean).map(id => node.getRootNode().getElementById?.(id)).some(note => note && visible(note) && /error|invalid|lỗi|không hợp lệ|bắt buộc|required/i.test(`${note.className} ${note.getAttribute('role')} ${note.textContent}`));
  const optionRows = container => [...(container ?? document).querySelectorAll('[role="option"], .dropdown-item, [role="menuitemradio"]')].filter(visible);
  // A custom picker shows its options only while open: open it, read the labels, close it again.
  // Only inside the composer: an unknown control elsewhere on the page is never clicked.
  const pickerOptions = async node => {
    const listId = node.getAttribute('aria-controls') || node.getAttribute('aria-owns');
    const listOf = () => (listId ? node.getRootNode().getElementById?.(listId) : null) ?? node.closest('.dropdown, [class*="select" i]') ?? node.parentElement;
    let rows = optionRows(listOf());
    const opened = !rows.length && node.getAttribute('aria-expanded') !== 'true' && scope !== document;
    if (opened) {
      node.click();
      for (let round = 0; round < 6 && !rows.length; round++) { await sleep(150); rows = optionRows(listOf()); }
    }
    const options = rows.slice(0, 40).map(row => {
      const label = safe(row.innerText?.split('\n').find(line => line.trim()) ?? row.textContent);
      return label ? { value: optionValue(row.getAttribute('data-value') ?? row.getAttribute('value') ?? label), label } : null;
    }).filter(Boolean);
    if (opened) {
      node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
      await sleep(100);
      if (node.getAttribute('aria-expanded') === 'true' || optionRows(listOf()).length) node.click();
    }
    return options;
  };

  const found = [];
  const seen = new Set();
  for (const node of all('select, input, textarea, [role="combobox"], [aria-haspopup="listbox"], [role="checkbox"], [role="switch"], [role="radio"]')) {
    if (seen.has(node) || !visible(node) || !contains(scope, node) || node.isContentEditable || isPrivate(node)) continue;
    // Without a composer form the page itself is the scope: leave site search and navigation alone.
    if (scope === document && node.closest('header, nav, [role="search"], [role="navigation"], [role="banner"]')) continue;
    if (editors.some(editor => editor === node || editor.contains(node))) continue;
    seen.add(node);
    const kind = kindOf(node);
    if (!kind) continue;
    found.push({ node, kind, required: Boolean(node.required) || node.getAttribute('aria-required') === 'true', invalid: invalid(node) });
  }
  // Required and invalid controls first, so they always fit in the list.
  found.sort((a, b) => Number(b.required || b.invalid) - Number(a.required || a.invalid));
  const controls = [];
  for (const item of found) {
    if (controls.length >= max) break;
    const selector = cssPath(item.node);
    if (!selector) continue;
    const { node, kind } = item;
    const control = {
      index: controls.length, kind, tag: node.tagName.toLowerCase().slice(0, 20), type: safe(node.getAttribute('type'), 30),
      label: safe(labelOf(node)), name: safe(node.getAttribute('name'), 60), id: safe(node.id, 60),
      required: item.required, invalid: item.invalid, selector,
    };
    if (kind === 'checkbox' || kind === 'radio') control.checked = checked(node);
    if (kind === 'select') {
      control.selected = safe(node.selectedOptions?.[0]?.textContent);
      control.options = [...node.options].filter(option => !option.disabled).slice(0, 40)
        .map(option => ({ value: optionValue(option.value), label: safe(option.textContent) ?? '' }));
    }
    if (kind === 'combobox') {
      // A button-like picker shows the chosen label; a typed search value is never sent.
      if (!node.matches('input, textarea')) control.selected = safe(node.innerText);
      control.options = await pickerOptions(node);
    }
    controls.push(Object.fromEntries(Object.entries(control).filter(([, value]) => value !== undefined)));
  }
  // The backend accepts URLs up to 2048 characters; a longer one loses only its query.
  return { url: location.href.length <= 2048 ? location.href : `${location.origin}${location.pathname}`.slice(0, 2048), controls };
}

/**
 * Applies the backend's form actions to the controls collected above. Each
 * action names one control by its unique selector; nothing else is clicked.
 */
export async function applyFormActions({ actions = [] } = {}) {
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const roots = [document];
  for (let i = 0; i < roots.length; i++) for (const node of roots[i].querySelectorAll('*')) if (node.shadowRoot) roots.push(node.shadowRoot);
  const all = selector => roots.flatMap(root => [...root.querySelectorAll(selector)]);
  const visible = node => node?.getClientRects().length > 0 && getComputedStyle(node).visibility !== 'hidden';
  const enabled = node => visible(node) && !node.disabled && node.getAttribute('aria-disabled') !== 'true';
  const normalize = value => String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
  const wait = async (find, timeout) => {
    const end = Date.now() + timeout;
    do { const result = find(); if (result) return result; await sleep(150); } while (Date.now() < end);
    return null;
  };
  const one = selector => { try { const found = all(selector).filter(visible); return found.length === 1 ? found[0] : null; } catch { return null; } };
  const fire = (node, ...types) => types.forEach(type => node.dispatchEvent(new Event(type, { bubbles: true })));
  const setText = (node, text) => {
    const proto = node.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    node.focus();
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(node, text);
    fire(node, 'input', 'change');
  };
  const isChecked = node => (node.matches('input') ? node.checked : node.getAttribute('aria-checked') === 'true');
  const firstLine = row => (row.innerText ?? row.textContent ?? '').split('\n').find(line => line.trim()) ?? '';
  const optionFor = (value, container) => {
    const rows = [...(container ?? document).querySelectorAll('[role="option"], .dropdown-item, [role="menuitemradio"]')].filter(enabled)
      .filter(row => [firstLine(row), row.innerText, row.getAttribute('data-value')].some(text => normalize(text) === normalize(value)));
    const deepest = rows.filter(row => !rows.some(other => other !== row && row.contains(other)));
    return deepest.length === 1 ? deepest[0] : null;
  };
  // A custom picker: open it, search when it has a search box, click the one matching option.
  const choose = async (node, value) => {
    const listId = node.getAttribute('aria-controls') || node.getAttribute('aria-owns');
    const container = () => (listId ? node.getRootNode().getElementById?.(listId) : null) ?? node.closest('.dropdown, [class*="select" i]') ?? node.parentElement;
    if (!optionFor(value, container()) && !node.matches('input')) node.click();
    let row = await wait(() => optionFor(value, container()), 1500);
    if (!row) {
      const search = node.matches('input') ? node : [...container().querySelectorAll('input:not([type="hidden"])')].find(enabled);
      if (search) { setText(search, value); row = await wait(() => optionFor(value, container()), 5000); }
    }
    if (!row) return false;
    row.click();
    await sleep(250);
    return true;
  };
  const tagLike = node => /tag|keyword|topic|chủ đề|từ khoá|từ khóa/i.test(`${node.name} ${node.placeholder} ${node.getAttribute('aria-label') || ''}`);

  const results = [];
  for (const action of actions) {
    const node = one(action.selector);
    let ok = false;
    try {
      if (!node || !enabled(node)) { results.push({ index: action.index, ok: false }); continue; }
      if (action.action === 'check' || action.action === 'uncheck') {
        const want = action.action === 'check';
        if (isChecked(node) !== want) node.click();
        await sleep(100);
        ok = isChecked(node) === want;
      } else if (action.action === 'select' && node.tagName === 'SELECT') {
        const option = [...node.options].find(item => !item.disabled && (normalize(item.textContent) === normalize(action.value) || item.value === action.value));
        if (option) {
          node.value = option.value;
          fire(node, 'input', 'change');
          ok = node.value === option.value;
        }
      } else if (action.action === 'select') {
        ok = await choose(node, action.value);
      } else if (action.action === 'type' && node.matches('input, textarea')) {
        if (node.getAttribute('role') === 'combobox' || node.getAttribute('aria-autocomplete')) ok = await choose(node, action.value);
        if (!ok) {
          setText(node, action.value);
          if (tagLike(node)) {
            // Tag inputs commit a typed tag with Enter.
            for (const type of ['keydown', 'keypress', 'keyup']) node.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
          }
          ok = true;
        }
      }
    } catch { ok = false; }
    results.push({ index: action.index, ok });
  }
  return { results };
}
