import { describe, expect, test } from 'bun:test';
import {
  deriveChatProvenance,
  PROVENANCE_BADGES,
} from '../dashboard/ui/src/hybrid/core.js';
import type { ChatProvenance } from '../dashboard/ui/src/hybrid/core.js';

/**
 * Per-response chat provenance: which path actually produced a live chat
 * response. The derivation takes two booleans taken at send time — whether
 * the local WebGPU path answered, and whether the hybrid layer (the prebuilt
 * chunk) was present at all — and never looks at message text. Semantics:
 *
 * - 'local-with-context': the browser's WebGPU model answered from the
 *   pre-fetched bundle (tryLocal returned {ok:true}).
 * - 'server-fallback': the server agent answered after the local layer was
 *   in play — hand-off (tool-call / outside-bundle / no-answer), cached
 *   WebGPU unavailable/failed verdict, config or bundle fetch failure, local
 *   error. HybridResult.reason deliberately does NOT influence the badge.
 * - 'unavailable' (neutral): the hybrid layer itself was absent (chunk 404 /
 *   window global undefined), so local inference was skipped entirely.
 */

describe('deriveChatProvenance', () => {
  describe('local answered → local-with-context, regardless of layer presence', () => {
    test('hybrid layer present', () => {
      expect(deriveChatProvenance({ localAnswered: true, hybridLayerPresent: true })).toBe(
        'local-with-context',
      );
    });

    test('hybrid layer absent (cannot happen in practice, but the local win dominates)', () => {
      expect(deriveChatProvenance({ localAnswered: true, hybridLayerPresent: false })).toBe(
        'local-with-context',
      );
    });
  });

  describe('local layer in play, server answered → server-fallback', () => {
    test('covers every {ok:false} reason: hand-offs, WebGPU unavailability, errors', () => {
      // The reason never changes the badge — the derivation never sees it.
      expect(deriveChatProvenance({ localAnswered: false, hybridLayerPresent: true })).toBe(
        'server-fallback',
      );
    });
  });

  describe('hybrid layer absent → unavailable (neutral)', () => {
    test('local inference skipped entirely (chunk 404 / window global undefined)', () => {
      expect(deriveChatProvenance({ localAnswered: false, hybridLayerPresent: false })).toBe(
        'unavailable',
      );
    });
  });

  test('derivation never reads message content — inputs are booleans only', () => {
    // Exhaustive matrix: 2 × 2 inputs → exactly three outputs.
    expect(
      new Set([
        deriveChatProvenance({ localAnswered: true, hybridLayerPresent: true }),
        deriveChatProvenance({ localAnswered: true, hybridLayerPresent: false }),
        deriveChatProvenance({ localAnswered: false, hybridLayerPresent: true }),
        deriveChatProvenance({ localAnswered: false, hybridLayerPresent: false }),
      ]),
    ).toEqual(new Set(['local-with-context', 'server-fallback', 'unavailable']));
  });
});

describe('PROVENANCE_BADGES', () => {
  const expectedStates: ChatProvenance[] = [
    'local-with-context',
    'server-fallback',
    'unavailable',
  ];

  test('has exactly the three ChatProvenance keys, no more', () => {
    expect(Object.keys(PROVENANCE_BADGES).sort()).toEqual([...expectedStates].sort());
  });

  test('every label is non-empty', () => {
    for (const state of expectedStates) {
      expect(PROVENANCE_BADGES[state].length).toBeGreaterThan(0);
    }
  });

  test('all three labels are distinct (guards a copy-paste typo shipping a wrong badge)', () => {
    expect(new Set(Object.values(PROVENANCE_BADGES)).size).toBe(expectedStates.length);
  });

  test('local state carries the on-device label; the two server states do not', () => {
    expect(PROVENANCE_BADGES['local-with-context']).toBe('answered locally · on-device');
    expect(PROVENANCE_BADGES['server-fallback']).toBe('server fallback');
    expect(PROVENANCE_BADGES['unavailable']).toBe('server agent');
  });
});