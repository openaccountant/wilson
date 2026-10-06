import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { linksRenderAsText } from '../dashboard/ui/src/hybrid/core.js';
import { getDashboardHtml } from '../dashboard/html.js';

/**
 * Round 3 "History links": every message reloaded from history renders links as
 * plain text (label only, no href), local or server. Live server answers keep
 * working links; current-session on-device answers stay inert.
 */

describe('linksRenderAsText', () => {
  test('history messages are inert whatever their provenance', () => {
    expect(linksRenderAsText({ fromHistory: true })).toBe(true);
    expect(linksRenderAsText({ fromHistory: true, provenance: 'server-continued' })).toBe(true);
    expect(linksRenderAsText({ fromHistory: true, provenance: 'server-fallback' })).toBe(true);
  });

  test('live on-device answers stay inert', () => {
    expect(linksRenderAsText({ provenance: 'local-with-context' })).toBe(true);
    expect(linksRenderAsText({ provenance: 'local-tools' })).toBe(true);
  });

  test('live server answers keep working links', () => {
    expect(linksRenderAsText({})).toBe(false);
    for (const p of ['server-continued', 'server-fallback', 'unavailable'] as const) {
      expect(linksRenderAsText({ provenance: p })).toBe(false);
    }
  });
});

describe('ChatTab.loadSession marks reloaded messages as history', () => {
  const tab = readFileSync(new URL('../dashboard/ui/src/tabs/ChatTab.tsx', import.meta.url), 'utf8');
  const fn = tab.slice(tab.indexOf('async function loadSession'), tab.indexOf('function handleNewChat'));

  test('both the user and assistant rows loaded from history carry fromHistory', () => {
    expect(fn).toMatch(/role: 'assistant', content: row\.answer, fromHistory: true/);
  });

  test('the assistant bubble picks the renderer through linksRenderAsText', () => {
    expect(tab).toMatch(/linksRenderAsText\(msg\)\s*\?\s*\(?\s*(\/\/[^\n]*\n\s*)?<LocalChatMarkdown>\{msg\.content\}<\/LocalChatMarkdown>/);
  });

  test('live pushes (server answers, local answers) never set fromHistory', () => {
    const outside = tab.replace(fn, '');
    expect(outside).not.toContain('fromHistory: true');
  });
});

describe('legacy dashboard page: history renders links as text', () => {
  const html = getDashboardHtml(3141);
  const m = /function renderMd\([^)]*\) \{[\s\S]*?\n  \}\n/.exec(html);

  test('renderSessionMessages renders history with plain links', () => {
    const rsm = /function renderSessionMessages[\s\S]*?\n  \}\n/.exec(html)![0];
    // History is the only markdown caller of addChatMsg, and addChatMsg's markdown branch always
    // renders plain links (#153), so reloaded answers can never carry an anchor. The behaviour is
    // also exercised end to end in dashboard-rendermd-xss.test.ts.
    expect(rsm).toMatch(/addChatMsg\('Wilson',row\.answer,true\)/);
    const acm = /function addChatMsg[\s\S]*?\n  \}\n/.exec(html)![0];
    expect(acm).toMatch(/if \(useMarkdown && text\) \{[\s\S]*?textDiv\.innerHTML = renderMd\(text, true\);[\s\S]*?\} else/);
    expect(acm).not.toMatch(/renderMd\(text\)/);
    expect(html.match(/addChatMsg\([^)]*,true\b/g) ?? []).toEqual(["addChatMsg('Wilson',row.answer,true"]);
  });

  test('live server answer path does not pass plainLinks', () => {
    expect(html).toContain('pendingText.innerHTML = renderMd(answer);');
  });

  test('renderMd(text, true) drops the href and keeps the label; default keeps the link', () => {
    expect(m).not.toBeNull();
    // eslint-disable-next-line no-new-func
    const renderMd = new Function(`var BT = String.fromCharCode(96), BT3 = BT+BT+BT; ${m![0]}; return renderMd;`)() as (t: string, plain?: boolean) => string;
    const md = 'See [your statement](https://evil.example/phish?d=1) now';
    const live = renderMd(md);
    expect(live).toContain('href="https://evil.example/phish?d=1"');
    const plain = renderMd(md, true);
    expect(plain).not.toContain('<a');
    expect(plain).not.toContain('href');
    expect(plain).not.toContain('phish');
    expect(plain).toContain('your statement');
  });
});
