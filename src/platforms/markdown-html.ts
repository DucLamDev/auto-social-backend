/**
 * Markdown → HTML for the rich-text editors the Chrome extension pastes into
 * (Medium, Substack, Tumblr…), so headings, lists and code blocks survive.
 *
 * Only the subset the AI writes is understood: ATX headings, paragraphs,
 * bullet / numbered lists (nested), fenced code, inline code, bold, italic,
 * strikethrough, http(s) links, blockquotes, horizontal rules and simple
 * tables. Every piece of text is escaped and raw HTML in the input is shown as
 * text, never passed through; links keep only http/https targets.
 */
export function markdownToHtml(markdown: string): string {
  const lines = markdown
    .replace(/\r\n?/g, '\n')
    // Private-use characters mark inline placeholders below; NUL has no meaning in a post.
    .replace(/[\uE000\uE001]/g, '')
    .replaceAll('\u0000', '')
    .split('\n');
  return renderBlocks(lines, 0);
}

/** Nesting of lists / blockquotes rendered as structure; deeper input becomes text. */
const MAX_DEPTH = 4;
const MAX_LINK_DEPTH = 3;

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));
}

// ---- Blocks -------------------------------------------------------------------

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)/;
const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*)$/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}>[ \t]?/;
const BULLET = /^([ \t]*)([-*+])[ \t]+(.*)$/;
const ORDERED = /^([ \t]*)(\d{1,9})[.)][ \t]+(.*)$/;
const TABLE_DELIMITER = /^[ \t]*\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;

interface ListMarker { ordered: boolean; indent: number; number: number; text: string }

/** Heading text without the optional closing `###` (scanned by hand: no backtracking on long lines). */
function headingText(raw: string): string {
  const text = raw.trimEnd();
  let end = text.length;
  while (end > 0 && text[end - 1] === '#') end -= 1;
  return end < text.length && (end === 0 || text[end - 1] === ' ' || text[end - 1] === '\t') ? text.slice(0, end).trimEnd() : text;
}

function isBlank(line: string): boolean {
  return !line.trim();
}

/** Leading columns, a tab counting as four. */
function indentOf(line: string): number {
  let columns = 0;
  for (const char of line) {
    if (char === ' ') columns += 1;
    else if (char === '\t') columns += 4;
    else break;
  }
  return columns;
}

function dedent(lines: string[]): string[] {
  const indents = lines.filter((line) => !isBlank(line)).map(indentOf);
  const amount = indents.length ? Math.min(...indents) : 0;
  return lines.map((line) => {
    let removed = 0;
    let index = 0;
    while (index < line.length && removed < amount && (line[index] === ' ' || line[index] === '\t')) {
      removed += line[index] === '\t' ? 4 : 1;
      index += 1;
    }
    return line.slice(index);
  });
}

function listMarker(line: string): ListMarker | null {
  if (RULE.test(line)) return null;
  const ordered = ORDERED.exec(line);
  if (ordered) return { ordered: true, indent: indentOf(ordered[1]!), number: Number(ordered[2]), text: ordered[3]!.trim() };
  const bullet = BULLET.exec(line);
  if (bullet) return { ordered: false, indent: indentOf(bullet[1]!), number: 1, text: bullet[3]!.trim() };
  return null;
}

function splitRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '');
  return trimmed.split(/(?<!\\)\|/).map((cell) => cell.trim());
}

function isTableStart(lines: string[], index: number): boolean {
  const header = lines[index];
  const delimiter = lines[index + 1];
  if (header === undefined || delimiter === undefined || !header.includes('|') || !TABLE_DELIMITER.test(delimiter)) return false;
  return splitRow(header).length === splitRow(delimiter).length;
}

function startsBlock(lines: string[], index: number): boolean {
  const line = lines[index]!;
  return FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || listMarker(line) !== null || isTableStart(lines, index);
}

/** Text that is not rendered as structure (too deep): escaped lines. */
function plainLines(lines: string[]): string {
  const text = lines.map((line) => line.trim()).filter(Boolean);
  return text.length ? `<p>${text.map((line) => renderInline(line)).join('<br>')}</p>` : '';
}

function renderBlocks(lines: string[], depth: number): string {
  if (depth > MAX_DEPTH) return plainLines(lines);
  const html: string[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    if (isBlank(line)) { index += 1; continue; }

    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1]!;
      const language = /^[\w+#.-]{1,30}$/.test(fence[2] ?? '') ? fence[2]! : '';
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !new RegExp(`^ {0,3}${marker[0] === '`' ? '`' : '~'}{${marker.length},}[ \\t]*$`).test(lines[index]!)) {
        code.push(lines[index]!);
        index += 1;
      }
      index += 1; // closing fence (an unclosed block runs to the end)
      html.push(`<pre><code${language ? ` class="language-${escapeHtml(language)}"` : ''}>${escapeHtml(code.join('\n'))}</code></pre>`);
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      html.push(`<h${level}>${renderInline(headingText(heading[2]!))}</h${level}>`);
      index += 1;
      continue;
    }

    if (RULE.test(line)) { html.push('<hr>'); index += 1; continue; }

    if (QUOTE.test(line)) {
      const quoted: string[] = [];
      while (index < lines.length && QUOTE.test(lines[index]!)) {
        quoted.push(lines[index]!.replace(QUOTE, ''));
        index += 1;
      }
      html.push(`<blockquote>${renderBlocks(quoted, depth + 1)}</blockquote>`);
      continue;
    }

    if (listMarker(line)) {
      const list = renderList(lines, index, depth);
      html.push(list.html);
      index = list.next;
      continue;
    }

    if (isTableStart(lines, index)) {
      const header = splitRow(line);
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length && !isBlank(lines[index]!) && lines[index]!.includes('|')) {
        const cells = splitRow(lines[index]!);
        rows.push(header.map((_cell, column) => cells[column] ?? ''));
        index += 1;
      }
      const head = `<thead><tr>${header.map((cell) => `<th>${renderInline(cell)}</th>`).join('')}</tr></thead>`;
      const body = rows.length ? `<tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${renderInline(cell)}</td>`).join('')}</tr>`).join('')}</tbody>` : '';
      html.push(`<table>${head}${body}</table>`);
      continue;
    }

    const paragraph: string[] = [];
    while (index < lines.length && !isBlank(lines[index]!) && (paragraph.length === 0 || !startsBlock(lines, index))) {
      paragraph.push(lines[index]!.trim());
      index += 1;
    }
    // Line breaks the author typed stay line breaks, as in the plain-text version.
    html.push(`<p>${paragraph.map((text) => renderInline(text)).join('<br>')}</p>`);
  }
  return html.join('');
}

function renderList(lines: string[], start: number, depth: number): { html: string; next: number } {
  const first = listMarker(lines[start]!)!;
  const items: Array<{ text: string[]; children: string[] }> = [];
  let index = start;
  while (index < lines.length) {
    const line = lines[index]!;
    if (isBlank(line)) {
      let ahead = index + 1;
      while (ahead < lines.length && isBlank(lines[ahead]!)) ahead += 1;
      const next = lines[ahead];
      if (next === undefined) break;
      const marker = listMarker(next);
      // "1. a" / blank / "2. b" is one list, not two lists that both start at 1.
      if (marker && marker.ordered === first.ordered && marker.indent <= first.indent + 1) { index = ahead; continue; }
      if (items.length && indentOf(next) > first.indent + 1) { items.at(-1)!.children.push(''); index = ahead; continue; }
      break;
    }
    const marker = listMarker(line);
    if (marker && marker.indent <= first.indent + 1) {
      if (marker.ordered !== first.ordered) break;
      items.push({ text: [marker.text], children: [] });
      index += 1;
      continue;
    }
    const item = items.at(-1);
    if (!item || indentOf(line) <= first.indent + 1) break;
    // Indented under the item: a nested list (and whatever follows it), or more item text.
    if (marker || item.children.length) item.children.push(line);
    else item.text.push(line.trim());
    index += 1;
  }
  const tag = first.ordered ? 'ol' : 'ul';
  const startAttribute = first.ordered && first.number !== 1 ? ` start="${first.number}"` : '';
  const body = items.map((item) => {
    const children = item.children.length ? renderBlocks(dedent(item.children), depth + 1) : '';
    return `<li>${item.text.map((text) => renderInline(text)).join('<br>')}${children}</li>`;
  }).join('');
  return { html: `<${tag}${startAttribute}>${body}</${tag}>`, next: index };
}

// ---- Inline -------------------------------------------------------------------

const ASCII_PUNCTUATION = /^[!-/:-@[-`{-~]$/;
const BARE_URL = /https?:\/\/[^\s<>"'`\uE000\uE001]+/iy;
const AUTOLINK = /<(https?:\/\/[^\s<>]+)>/iy;

function safeHref(raw: string): string | null {
  try {
    const url = new URL(raw.trim());
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

/** `[label](destination "title")` starting at `start`; null when the text is not a link. */
function parseLink(text: string, start: number): { label: string; destination: string; end: number } | null {
  let depth = 0;
  let index = start;
  for (; index < text.length; index += 1) {
    const char = text[index];
    if (char === '\\') { index += 1; continue; }
    if (char === '[') depth += 1;
    else if (char === ']') { depth -= 1; if (depth === 0) break; }
  }
  if (depth !== 0 || text[index + 1] !== '(') return null;
  const label = text.slice(start + 1, index);
  let cursor = index + 2;
  while (text[cursor] === ' ' || text[cursor] === '\t') cursor += 1;
  let destination = '';
  if (text[cursor] === '<') {
    const close = text.indexOf('>', cursor);
    if (close < 0) return null;
    destination = text.slice(cursor + 1, close);
    cursor = close + 1;
  } else {
    let parens = 0;
    const begin = cursor;
    for (; cursor < text.length; cursor += 1) {
      const char = text[cursor]!;
      if (char === '\\') { cursor += 1; continue; }
      if (/\s/.test(char)) break;
      if (char === '(') parens += 1;
      else if (char === ')') { if (parens === 0) break; parens -= 1; }
    }
    destination = text.slice(begin, cursor);
  }
  while (text[cursor] === ' ' || text[cursor] === '\t') cursor += 1;
  const quote = text[cursor];
  if (quote === '"' || quote === "'") {
    const close = text.indexOf(quote, cursor + 1);
    if (close < 0) return null;
    cursor = close + 1;
    while (text[cursor] === ' ' || text[cursor] === '\t') cursor += 1;
  }
  if (text[cursor] !== ')') return null;
  return { label, destination, end: cursor + 1 };
}

/** Strips punctuation that ends a sentence rather than the URL, and an unmatched closing bracket. */
function trimBareUrl(url: string): string {
  let result = url.replace(/[.,;:!?*_~]+$/, '');
  while (/[)\]]$/.test(result)) {
    const close = result.endsWith(')') ? ')' : ']';
    const open = close === ')' ? '(' : '[';
    if (result.split(open).length >= result.split(close).length) break;
    result = result.slice(0, -1).replace(/[.,;:!?*_~]+$/, '');
  }
  return result;
}

function renderInline(text: string, linkDepth = 0, insideLink = false): string {
  const tokens: string[] = [];
  const hold = (html: string) => `\uE000${tokens.push(html) - 1}\uE001`;
  let buffer = '';
  let index = 0;
  while (index < text.length) {
    const char = text[index]!;
    const next = text[index + 1];
    if (char === '\\' && next !== undefined && ASCII_PUNCTUATION.test(next)) {
      buffer += hold(escapeHtml(next));
      index += 2;
      continue;
    }
    if (char === '`') {
      let run = 1;
      while (text[index + run] === '`') run += 1;
      const fence = '`'.repeat(run);
      let close = text.indexOf(fence, index + run);
      while (close >= 0 && text[close + run] === '`') close = text.indexOf(fence, close + run + 1);
      if (close >= 0) {
        const code = text.slice(index + run, close).replace(/^ (.*\S.*) $/, '$1');
        buffer += hold(`<code>${escapeHtml(code)}</code>`);
        index = close + run;
        continue;
      }
      buffer += fence;
      index += run;
      continue;
    }
    if ((char === '[' || (char === '!' && next === '[')) && !insideLink) {
      const image = char === '!';
      const link = parseLink(text, image ? index + 1 : index);
      if (link) {
        const href = safeHref(link.destination.replace(/\\(.)/g, '$1'));
        const label = linkDepth >= MAX_LINK_DEPTH ? escapeHtml(link.label) : renderInline(link.label, linkDepth + 1, true);
        // Images are not pasted (the editor would fetch any URL); their description stays as text.
        buffer += hold(!image && href ? `<a href="${escapeHtml(href)}">${label}</a>` : label);
        index = link.end;
        continue;
      }
    }
    if (char === '<' && !insideLink) {
      AUTOLINK.lastIndex = index;
      const autolink = AUTOLINK.exec(text);
      const href = autolink ? safeHref(autolink[1]!) : null;
      if (autolink && href) {
        buffer += hold(`<a href="${escapeHtml(href)}">${escapeHtml(autolink[1]!)}</a>`);
        index += autolink[0].length;
        continue;
      }
    }
    if ((char === 'h' || char === 'H') && !insideLink && !/[\p{L}\p{N}]/u.test(text[index - 1] ?? '')) {
      BARE_URL.lastIndex = index;
      const bare = BARE_URL.exec(text);
      if (bare) {
        const url = trimBareUrl(bare[0]);
        const href = safeHref(url);
        if (href && url.length > 'https://'.length) {
          buffer += hold(`<a href="${escapeHtml(href)}">${escapeHtml(url)}</a>`);
          index += url.length;
          continue;
        }
      }
    }
    buffer += char;
    index += 1;
  }
  // Emphasis is applied to escaped text: escaping never produces * _ or ~,
  // and the only markup added here are fixed tags.
  const html = escapeHtml(buffer)
    .replace(/\*\*\*(?=\S)([^\n]+?)(?<=\S)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*(?=\S)([^\n]+?)(?<=\S)\*\*/g, '<strong>$1</strong>')
    .replace(/(?<![\p{L}\p{N}_])__(?=\S)([^\n]+?)(?<=\S)__(?![\p{L}\p{N}_])/gu, '<strong>$1</strong>')
    .replace(/~~(?=\S)([^\n]+?)(?<=\S)~~/g, '<del>$1</del>')
    .replace(/(?<![\p{L}\p{N}*])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?![\p{L}\p{N}*])/gu, '<em>$1</em>')
    .replace(/(?<![\p{L}\p{N}_])_(?=[^\s_])([^_\n]*?[^\s_])_(?![\p{L}\p{N}_])/gu, '<em>$1</em>');
  return html.replace(/\uE000(\d+)\uE001/g, (_match, position: string) => tokens[Number(position)]!);
}
