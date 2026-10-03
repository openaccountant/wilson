import { describe, expect, test } from 'bun:test';
import { getDashboardHtml } from '../dashboard/html.js';

// The legacy dashboard ships renderMd() as client JS inside a template string.
// Extract the evaluated function text from the generated page and run it.
const html = getDashboardHtml(0);
const start = html.indexOf('var BT = String.fromCharCode(96)');
const end = html.indexOf('function addChatMsg');
if (start < 0 || end < 0) throw new Error('renderMd source not found in dashboard html');
const renderMd: (text: string, plainLinks?: boolean) => string = new Function(
  `${html.slice(start, end)}; return renderMd;`,
)();

function anchors(out: string): string[] {
  return [...out.matchAll(/<a\b[^>]*>/g)].map((m) => m[0]);
}

describe('legacy dashboard renderMd (#153)', () => {
  test('attribute injection via double quote in href cannot add attributes', () => {
    const out = renderMd('[x](http://a" onmouseover="alert(1))');
    expect(out).not.toContain('" onmouseover');
    expect(anchors(out)).toHaveLength(1);
    for (const a of anchors(out)) {
      expect(a).toMatch(/^<a href="[^"]*" target="_blank" rel="noopener">$/);
    }
  });

  test('attribute injection without a safe scheme renders as text, no anchor', () => {
    const out = renderMd('[x](a" onmouseover="alert(1))');
    expect(anchors(out)).toHaveLength(0);
    expect(out).not.toMatch(/<[^>]*\sonmouseover=/i);
  });

  test('single quotes are escaped', () => {
    const out = renderMd("it's <b>\"hi\"</b>");
    expect(out).toContain('&#39;');
    expect(out).toContain('&quot;');
    expect(out).not.toContain('<b>');
  });

  test('javascript: links render as text', () => {
    for (const url of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', ' javascript:alert(1)', 'data:text/html,<script>1</script>', 'vbscript:x', '//evil.example/x', 'java\tscript:alert(1)']) {
      const out = renderMd(`[click](${url})`);
      expect(anchors(out)).toHaveLength(0);
      expect(out).toContain('click');
      expect(out).not.toMatch(/href=/i);
    }
  });

  test('http, https and mailto links still render as anchors', () => {
    expect(renderMd('[a](https://example.com/p?q=1&r=2)')).toContain(
      '<a href="https://example.com/p?q=1&amp;r=2" target="_blank" rel="noopener">a</a>',
    );
    expect(renderMd('[a](http://example.com)')).toContain('href="http://example.com"');
    expect(renderMd('[a](mailto:me@example.com)')).toContain('href="mailto:me@example.com"');
  });

  test('markdown emphasis cannot inject tags into an href', () => {
    const out = renderMd('[x](http://a/*b*c)');
    for (const a of anchors(out)) expect(a).not.toMatch(/href="[^"]*[<>]/);
  });

  test('plainLinks mode (on-device answers) renders no anchors, keeps link text', () => {
    const out = renderMd('see [docs](https://example.com) and **bold**', true);
    expect(anchors(out)).toHaveLength(0);
    expect(out).not.toMatch(/href=/i);
    expect(out).toContain('docs');
    expect(out).toContain('<strong>bold</strong>');
  });

  test('on-device (localAnswer) call site opts into plain links; server path does not', () => {
    expect(html).toMatch(/renderMd\(localAnswer, true\)/);
    expect(html).toMatch(/renderMd\(answer\)/);
  });

  test('messages reloaded from session history render links as text (local or server)', () => {
    const rsStart = html.indexOf('var BT = String.fromCharCode(96)');
    const rsEnd = html.indexOf('async function loadSessions');
    const src = html.slice(rsStart, rsEnd);
    const fakeEl = (_tag = '', cls = '', text = '') => {
      const node: any = { className: cls, textContent: text, innerHTML: '', children: [] as any[] };
      node.appendChild = (c: any) => { node.children.push(c); return c; };
      node.querySelector = () => null;
      return node;
    };
    const chatMessages: any = fakeEl('div');
    chatMessages.replaceChildren = () => { chatMessages.children.length = 0; };
    const run = new Function(
      'chatMessages', 'el',
      `${src}; return renderSessionMessages;`,
    )(chatMessages, fakeEl) as (m: unknown[]) => void;
    run([{ query: 'q', answer: 'see [docs](https://example.com) and **bold**' }]);
    const bubbleHtml = chatMessages.children
      .filter((m: any) => m.className.includes('msg-assistant'))
      .map((m: any) => m.children.find((c: any) => c.className === 'bubble').children[0].innerHTML)
      .join('');
    expect(bubbleHtml).toContain('<strong>bold</strong>');
    expect(bubbleHtml).toContain('docs');
    expect(anchors(bubbleHtml)).toHaveLength(0);
    expect(bubbleHtml).not.toMatch(/href=/i);
  });
});
