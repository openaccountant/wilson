import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { withPendingOperations, type AgentState, type AgentPendingOperation } from '../dashboard/agent-access-model.js';

/**
 * L6: the floating panel said "2 pending" while three cards were showing, because the count came from the 5 s state
 * snapshot and the cards from the 1.5 s operations poll. One pass now drives both.
 */

const op = (id: string): AgentPendingOperation => ({ id, source: 'webmcp', tool_name: 'review_action' });
const state = (pending: AgentPendingOperation[]): AgentState => ({
  enabled: true, grantTtlMinutes: 60, ttlOptions: [15, 60], role: 'admin', authEnabled: false, tools: [], pending, auditTail: [],
});

describe('withPendingOperations', () => {
  test('the poller\'s fresher list replaces the snapshot\'s: 2 pending becomes 3', () => {
    const before = state([op('a'), op('b')]);
    const after = withPendingOperations(before, [op('a'), op('b'), op('c')]);
    expect(after).not.toBe(before);
    expect(after?.pending.map((o) => o.id)).toEqual(['a', 'b', 'c']);
    // Everything else in the snapshot is untouched.
    expect(after).toMatchObject({ enabled: true, role: 'admin', grantTtlMinutes: 60 });
  });

  test('answered elsewhere: the count goes down too', () => {
    expect(withPendingOperations(state([op('a'), op('b')]), [op('b')])?.pending).toHaveLength(1);
    expect(withPendingOperations(state([op('a')]), [])?.pending).toEqual([]);
  });

  test('the same ids in the same order return the SAME object, so an idle poll re-renders nothing', () => {
    const before = state([op('a'), op('b')]);
    expect(withPendingOperations(before, [op('a'), op('b')])).toBe(before);
  });

  test('no snapshot yet: nothing to update', () => {
    expect(withPendingOperations(null, [op('a')])).toBeNull();
  });
});

describe('the bridge wires the count to the same pass as the cards (source guard)', () => {
  const code = readFileSync(new URL('../dashboard/webmcp-bridge.ts', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

  test('the card poller reconciles cards and the pending count in one applyOperations call', () => {
    // Chat-raised operations are answered by the Chat tab's card, so the bridge filters them out first (one surface each).
    expect(code).toMatch(/function applyOperations\(all: McpOperation\[\], options: \{ cards: boolean \}\)[\s\S]{0,300}const operations = bridgeOwnedOperations\(all\);[\s\S]{0,200}reconcileCards\(operations\)[\s\S]{0,200}withPendingOperations\(agentState, operations\)/);
    // The poller is a visibility-gated setTimeout chain (webmcp-polling.ts decides the cadence).
    expect(code).toMatch(/async function pollConfirmations\(\): Promise<void> \{\s*await refreshPending\(\{ cards: true \}\);\s*scheduleConfirmationPoll\(\);/);
    expect(code).toMatch(/nextConfirmationPollDelay\(\{\s*hidden: !tabIsVisible\(\),/);
    expect(code).toMatch(/applyOperations\(res\.operations, options\)/);
  });

  test('toolchange (on document.modelContext) and grants/state changes refresh the count too', () => {
    expect(code).toMatch(/addEventListener\('toolchange'[\s\S]{0,200}refreshPending\(/);
    expect(code).toMatch(/const onChanged = \(e: Event\) => \{[\s\S]{0,400}refreshPending\(/);
  });

  test('the panel re-renders when the count changes', () => {
    expect(code).toMatch(/agentState = next;\s*onStateChange\?\.\(\);/);
  });
});

describe('L3 + L4 wiring in the bridge (source guard)', () => {
  const code = readFileSync(new URL('../dashboard/webmcp-bridge.ts', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

  test('every imperative and page execute goes through the error-as-result wrappers and is tracked as in flight', () => {
    expect(code).toMatch(/trackCall\(tool\.name, \(call\) => executeServerTool\(/);
    expect(code).toMatch(/trackCall\(tool\.name, \(call\) =>\s*executePageTool\(/);
    expect(code).toContain('isBusy: (name) => (inFlight.get(name) ?? 0) > 0');
  });

  test('a call that settles asks for a reconcile, so what was deferred happens now', () => {
    expect(code).toMatch(/inFlight\.delete\(name\);[\s\S]{0,200}scheduler\.request\(\)/);
  });

  test('the published live info carries the policy, and a no-op publish is skipped by signature', () => {
    expect(code).toMatch(/autosubmit: t\.autosubmit,\s*policy: t\.policy,/);
    expect(code).toContain('if (signature === publishedSignature) return;');
  });

  test('a revoked grant is a ToolCallError result, not a bare Error', () => {
    expect(code).not.toMatch(/new Error\(`Access to/);
    expect(code).toContain("new ToolCallError('grant_invalid'");
  });
});
