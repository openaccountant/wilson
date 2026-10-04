import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Source guards for J2 (threat T16): an agent-driven preselect, scroll or tab change must never put a one-click
 * Confirm/Apply button under the pointer. The pure rules are tested in webmcp-page-tools-core.test.ts; these check
 * that the UI really uses them.
 */
const UI = join(import.meta.dir, '../dashboard/ui/src');
const read = (rel: string) => readFileSync(join(UI, rel), 'utf8');

describe('agent action guard wiring', () => {
  const review = read('tabs/ReviewTab.tsx');
  const transactions = read('tabs/TransactionsTab.tsx');
  const guard = read('agent/agentGuard.ts');
  const provider = read('agent/WebMcpProvider.tsx');

  test('no agent scroll centres a row (block: center) anywhere an agent handler runs', () => {
    for (const src of [review, transactions, guard, provider]) expect(src).not.toMatch(/block:\s*'center'/);
  });

  test("the one scroll helper uses block: 'nearest' and asks the pure rule whether to scroll at all", () => {
    expect(guard).toContain("block: 'nearest'");
    expect(guard).toContain('shouldScrollForAgent');
    expect(guard).toContain("from '@webmcp-page-tools'");
  });

  test('ReviewTab and TransactionsTab scroll through the helper, never scrollIntoView directly', () => {
    for (const src of [review, transactions]) {
      expect(src).toContain('scrollForAgent(');
      expect(src).not.toContain('.scrollIntoView(');
    }
  });

  test('ReviewTab disables the row buttons and the form submit for the guard window, with a visible state', () => {
    expect(review).toContain('useAgentGuard');
    expect(review).toMatch(/disabled=\{busy \|\| guarded\}/);
    expect(review).toContain('data-agent-guard');
    expect(review).toContain('Agent moved the view');
  });

  test('the guard is armed by every agent-driven move: preselect, open_transaction, and a tab change', () => {
    expect(review).toContain('armGuard()');
    expect(transactions).toContain('armPageGuard()');
    expect(provider).toContain('armPageGuard()');
  });

  test('the page guard blocks clicks in the capture phase for AGENT_GUARD_MS and cleans up after itself', () => {
    expect(guard).toContain('AGENT_GUARD_MS');
    expect(guard).toMatch(/addEventListener\('click'.*true\)/s);
    expect(guard).toMatch(/removeEventListener\('click'/);
    expect(guard).toContain('data-agent-guard');
  });
});

describe('agent guard is armed before the layout moves', () => {
  const read = (rel: string) => require('node:fs').readFileSync(require('node:path').join(import.meta.dir, rel), 'utf8') as string;
  test('navigate_to_tab arms the guard before switching tabs', () => {
    const src = read('../dashboard/ui/src/agent/WebMcpProvider.tsx');
    expect(src.indexOf('armPageGuard();\n          navigateRef.current(tab);')).toBeGreaterThan(-1);
  });
  test('open_transaction arms the guard before clearing filters', () => {
    const src = read('../dashboard/ui/src/tabs/TransactionsTab.tsx');
    expect(src.indexOf('armPageGuard()')).toBeLessThan(src.indexOf("setSearch('');"));
  });
});
