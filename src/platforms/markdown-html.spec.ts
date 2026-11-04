import { escapeHtml, markdownToHtml } from './markdown-html';

describe('markdownToHtml', () => {
  it('renders ATX headings of every level and ignores hashtags', () => {
    expect(markdownToHtml('# One\n## Two ##\n###### Six')).toBe('<h1>One</h1><h2>Two</h2><h6>Six</h6>');
    expect(markdownToHtml('#vps #linux')).toBe('<p>#vps #linux</p>');
    expect(markdownToHtml('## C# tips #')).toBe('<h2>C# tips</h2>');
    expect(markdownToHtml('## ###')).toBe('<h2></h2>');
    // A long heading line is handled in linear time.
    const started = Date.now();
    expect(markdownToHtml(`# a${' '.repeat(50_000)}b`)).toMatch(/^<h1>a +b<\/h1>$/);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('keeps paragraphs apart and the line breaks the author typed', () => {
    expect(markdownToHtml('First line\nsecond line\n\n\nNext paragraph')).toBe('<p>First line<br>second line</p><p>Next paragraph</p>');
    expect(markdownToHtml('')).toBe('');
    expect(markdownToHtml('\r\n\r\n')).toBe('');
  });

  it('renders bold, italic, strikethrough and inline code', () => {
    expect(markdownToHtml('**bold** and __strong__, *em* and _em_, ~~old~~ `a < b`'))
      .toBe('<p><strong>bold</strong> and <strong>strong</strong>, <em>em</em> and <em>em</em>, <del>old</del> <code>a &lt; b</code></p>');
    expect(markdownToHtml('***both***')).toBe('<p><strong><em>both</em></strong></p>');
  });

  it('leaves snake_case names, arithmetic and lone markers alone', () => {
    expect(markdownToHtml('set max_body_size and 2 * 3 * 4')).toBe('<p>set max_body_size and 2 * 3 * 4</p>');
    expect(markdownToHtml('a ** b')).toBe('<p>a ** b</p>');
  });

  it('does not format inside code spans and honours backslash escapes', () => {
    expect(markdownToHtml('`**not bold** [x](https://a.example)`')).toBe('<p><code>**not bold** [x](https://a.example)</code></p>');
    expect(markdownToHtml('\\*literal\\* and \\# not a heading')).toBe('<p>*literal* and # not a heading</p>');
    expect(markdownToHtml('``code with ` tick``')).toBe('<p><code>code with ` tick</code></p>');
  });

  it('renders fenced code blocks with their language and escapes the code', () => {
    expect(markdownToHtml('```nginx\nserver { listen 80; }\n# not a heading\n<b>x</b>\n```\nAfter'))
      .toBe('<pre><code class="language-nginx">server { listen 80; }\n# not a heading\n&lt;b&gt;x&lt;/b&gt;</code></pre><p>After</p>');
    expect(markdownToHtml('~~~\nplain\n~~~')).toBe('<pre><code>plain</code></pre>');
    // An unclosed fence runs to the end instead of swallowing nothing.
    expect(markdownToHtml('```\nopen')).toBe('<pre><code>open</code></pre>');
    // A hostile info string never becomes an attribute.
    expect(markdownToHtml('```"onclick="x\ncode\n```')).toBe('<pre><code>code</code></pre>');
  });

  it('renders bullet and numbered lists with one nested level', () => {
    expect(markdownToHtml('- one\n- **two**\n  - nested a\n  - nested b\n- three'))
      .toBe('<ul><li>one</li><li><strong>two</strong><ul><li>nested a</li><li>nested b</li></ul></li><li>three</li></ul>');
    expect(markdownToHtml('1. first\n2. second\n   continued')).toBe('<ol><li>first</li><li>second<br>continued</li></ol>');
    expect(markdownToHtml('3) third\n4) fourth')).toBe('<ol start="3"><li>third</li><li>fourth</li></ol>');
  });

  it('keeps one numbered list across blank lines and splits lists of different kinds', () => {
    expect(markdownToHtml('1. a\n\n2. b\n\n3. c')).toBe('<ol><li>a</li><li>b</li><li>c</li></ol>');
    expect(markdownToHtml('- a\n1. b')).toBe('<ul><li>a</li></ul><ol><li>b</li></ol>');
    expect(markdownToHtml('Intro:\n- a\n- b\n\nOutro')).toBe('<p>Intro:</p><ul><li>a</li><li>b</li></ul><p>Outro</p>');
  });

  it('renders blockquotes and horizontal rules', () => {
    expect(markdownToHtml('> quoted **text**\n> second line\n\n---\n\n***')).toBe('<blockquote><p>quoted <strong>text</strong><br>second line</p></blockquote><hr><hr>');
    expect(markdownToHtml('> - item\n> - item 2')).toBe('<blockquote><ul><li>item</li><li>item 2</li></ul></blockquote>');
  });

  it('renders simple tables and pads short rows', () => {
    expect(markdownToHtml('| Plan | RAM |\n|---|:---:|\n| Basic | 2 GB |\n| Pro |\n\nAfter'))
      .toBe('<table><thead><tr><th>Plan</th><th>RAM</th></tr></thead><tbody><tr><td>Basic</td><td>2 GB</td></tr><tr><td>Pro</td><td></td></tr></tbody></table><p>After</p>');
    expect(markdownToHtml('a | b\n--- | ---\n`x\\|y` | **z**')).toBe('<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td><code>x\\|y</code></td><td><strong>z</strong></td></tr></tbody></table>');
    // A pipe in a sentence is not a table.
    expect(markdownToHtml('either a | b\nor c')).toBe('<p>either a | b<br>or c</p>');
  });

  it('links only http and https targets', () => {
    expect(markdownToHtml('[Docs](https://nginx.org/en/docs/ "Title") and <https://vpsttt.com>'))
      .toBe('<p><a href="https://nginx.org/en/docs/">Docs</a> and <a href="https://vpsttt.com/">https://vpsttt.com</a></p>');
    expect(markdownToHtml('[mail](mailto:a@example.com) [ftp](ftp://x.example/f) [rel](/path)')).toBe('<p>mail ftp rel</p>');
    expect(markdownToHtml('[Wiki](https://en.wikipedia.org/wiki/Nginx_(software))')).toBe('<p><a href="https://en.wikipedia.org/wiki/Nginx_(software)">Wiki</a></p>');
  });

  it('turns a bare source URL into a link without the sentence punctuation', () => {
    expect(markdownToHtml('Nguồn: https://vpsttt.com/blog/vps-gia-re.')).toBe('<p>Nguồn: <a href="https://vpsttt.com/blog/vps-gia-re">https://vpsttt.com/blog/vps-gia-re</a>.</p>');
    expect(markdownToHtml('(see https://example.com/a)')).toBe('<p>(see <a href="https://example.com/a">https://example.com/a</a>)</p>');
    expect(markdownToHtml('**https://example.com**')).toBe('<p><strong><a href="https://example.com/">https://example.com</a></strong></p>');
  });

  it('shows image syntax as its description instead of loading a remote file', () => {
    expect(markdownToHtml('![Server rack](https://tracker.example/pixel.png)')).toBe('<p>Server rack</p>');
  });

  describe('untrusted input', () => {
    it('escapes raw HTML instead of passing it through', () => {
      expect(markdownToHtml('<script>alert(1)</script>')).toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
      expect(markdownToHtml('<img src=x onerror=alert(1)>\n\n<div>block</div>')).toBe('<p>&lt;img src=x onerror=alert(1)&gt;</p><p>&lt;div&gt;block&lt;/div&gt;</p>');
      expect(markdownToHtml('# <iframe src="/evil">')).toBe('<h1>&lt;iframe src=&quot;/evil&quot;&gt;</h1>');
      // A URL inside pasted markup becomes a link of its own; the markup stays text.
      expect(markdownToHtml('<iframe src="https://evil.example">')).toBe('<p>&lt;iframe src=&quot;<a href="https://evil.example/">https://evil.example</a>&quot;&gt;</p>');
      expect(markdownToHtml('Tom & Jerry\'s "quote" &amp;')).toBe('<p>Tom &amp; Jerry&#39;s &quot;quote&quot; &amp;amp;</p>');
    });

    it('never links javascript:, data: or vbscript: targets, in any letter case', () => {
      for (const target of ['javascript:alert(1)', 'JaVaScRiPt:alert(document.cookie)', ' javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'vbscript:msgbox(1)']) {
        const html = markdownToHtml(`[click](${target})`);
        expect(html).not.toMatch(/<a\b/);
        expect(html).not.toMatch(/<script/i);
      }
      expect(markdownToHtml('<javascript:alert(1)>')).toBe('<p>&lt;javascript:alert(1)&gt;</p>');
    });

    it('cannot break out of the href attribute', () => {
      const html = markdownToHtml('[x](https://a.example/"onmouseover="alert(1)) [y](<https://a.example/" onclick="alert(1)>)');
      expect(html).not.toMatch(/"\s*on\w+=/);
      expect(html).toContain('href="https://a.example/%22onmouseover=%22alert(1)"');
      expect(markdownToHtml('https://a.example/?q="><script>alert(1)</script>')).not.toContain('<script>');
    });

    it('escapes link labels and table cells', () => {
      expect(markdownToHtml('[<b onclick=alert(1)>hi</b>](https://a.example)')).toBe('<p><a href="https://a.example/">&lt;b onclick=alert(1)&gt;hi&lt;/b&gt;</a></p>');
      expect(markdownToHtml('| <script> |\n|---|\n| "x" |')).toBe('<table><thead><tr><th>&lt;script&gt;</th></tr></thead><tbody><tr><td>&quot;x&quot;</td></tr></tbody></table>');
    });

    it('does not let placeholder characters or deep nesting through', () => {
      expect(markdownToHtml('a\uE0000\uE001b\u0000c')).toBe('<p>a0bc</p>');
      const deep = markdownToHtml(`${'>'.repeat(200)} deep`);
      expect(deep).toContain('deep');
      expect(deep.match(/<blockquote>/g)!.length).toBeLessThanOrEqual(5);
      expect(markdownToHtml(`${'['.repeat(500)}x${']'.repeat(500)}`)).toContain('x');
    });
  });

  it('renders a realistic multi-section post', () => {
    const post = [
      '## Vì sao VPS chậm vào giờ cao điểm?',
      '',
      'Nhiều bạn hỏi mình: **VPS 2 GB RAM** có đủ cho WordPress không? Câu trả lời ngắn: *đủ*, nếu cấu hình đúng.',
      '',
      '### Ba việc cần làm',
      '',
      '1. Bật cache trang',
      '2. Giới hạn `pm.max_children` của PHP-FPM',
      '   - 2 GB RAM: khoảng 10',
      '   - 4 GB RAM: khoảng 20',
      '3. Theo dõi bằng `htop`',
      '',
      '```bash',
      'sudo systemctl restart php8.3-fpm',
      '```',
      '',
      '> Mẹo: đo trước rồi mới nâng cấp.',
      '',
      '| Gói | RAM |',
      '|---|---|',
      '| Basic | 2 GB |',
      '',
      '---',
      '',
      'Đọc thêm [hướng dẫn tối ưu](https://vpsttt.com/blog/toi-uu).',
      '',
      'Nguồn: https://vpsttt.com/blog/vps',
    ].join('\n');
    expect(markdownToHtml(post)).toBe([
      '<h2>Vì sao VPS chậm vào giờ cao điểm?</h2>',
      '<p>Nhiều bạn hỏi mình: <strong>VPS 2 GB RAM</strong> có đủ cho WordPress không? Câu trả lời ngắn: <em>đủ</em>, nếu cấu hình đúng.</p>',
      '<h3>Ba việc cần làm</h3>',
      '<ol><li>Bật cache trang</li><li>Giới hạn <code>pm.max_children</code> của PHP-FPM<ul><li>2 GB RAM: khoảng 10</li><li>4 GB RAM: khoảng 20</li></ul></li><li>Theo dõi bằng <code>htop</code></li></ol>',
      '<pre><code class="language-bash">sudo systemctl restart php8.3-fpm</code></pre>',
      '<blockquote><p>Mẹo: đo trước rồi mới nâng cấp.</p></blockquote>',
      '<table><thead><tr><th>Gói</th><th>RAM</th></tr></thead><tbody><tr><td>Basic</td><td>2 GB</td></tr></tbody></table>',
      '<hr>',
      '<p>Đọc thêm <a href="https://vpsttt.com/blog/toi-uu">hướng dẫn tối ưu</a>.</p>',
      '<p>Nguồn: <a href="https://vpsttt.com/blog/vps">https://vpsttt.com/blog/vps</a></p>',
    ].join(''));
  });

  it('escapes every HTML-significant character', () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe('&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
  });
});
