import { describe, test, expect } from 'bun:test';
import {
  bridgeOwnedOperations,
  nextConfirmationPollDelay,
  nextToolSyncDelay,
  CONFIRMATION_FAST_MS,
  CONFIRMATION_GRANTED_MS,
  CONFIRMATION_IDLE_MS,
  TOOL_SYNC_LIVE_MS,
  TOOL_SYNC_LATE_REGISTRATION_MS,
  TOOL_SYNC_LATE_ATTEMPTS,
} from '../dashboard/webmcp-polling.js';

describe('bridgeOwnedOperations', () => {
  test('drops chat-sourced operations (ChatTab renders its own approval card)', () => {
    const ops = [
      { id: 'a', source: 'chat' },
      { id: 'b', source: 'webmcp' },
      { id: 'c', source: 'http-mcp' },
    ];
    expect(bridgeOwnedOperations(ops).map((o) => o.id)).toEqual(['b', 'c']);
  });
});

describe('nextConfirmationPollDelay', () => {
  const base = { hidden: false, hasLiveGrants: false, bridgePending: false, lastPollHadPending: false };

  test('pauses while the tab is hidden', () => {
    expect(nextConfirmationPollDelay({ ...base, hidden: true, bridgePending: true })).toBeNull();
  });
  test('polls fast only while something is pending', () => {
    expect(nextConfirmationPollDelay({ ...base, bridgePending: true })).toBe(CONFIRMATION_FAST_MS);
    expect(nextConfirmationPollDelay({ ...base, lastPollHadPending: true })).toBe(CONFIRMATION_FAST_MS);
  });
  test('medium cadence with live grants, slow when idle', () => {
    expect(nextConfirmationPollDelay({ ...base, hasLiveGrants: true })).toBe(CONFIRMATION_GRANTED_MS);
    expect(nextConfirmationPollDelay(base)).toBe(CONFIRMATION_IDLE_MS);
    expect(CONFIRMATION_IDLE_MS).toBeGreaterThan(CONFIRMATION_GRANTED_MS);
    expect(CONFIRMATION_GRANTED_MS).toBeGreaterThan(CONFIRMATION_FAST_MS);
  });
});

describe('nextToolSyncDelay', () => {
  test('never ticks while hidden', () => {
    expect(nextToolSyncDelay({ hidden: true, webmcpAvailable: true, registeredCount: 3, lateAttempts: 0 })).toBeNull();
  });
  test('no WebMCP: bounded late-registration retries, then stops', () => {
    expect(nextToolSyncDelay({ hidden: false, webmcpAvailable: false, registeredCount: 0, lateAttempts: 0 })).toBe(
      TOOL_SYNC_LATE_REGISTRATION_MS,
    );
    expect(
      nextToolSyncDelay({ hidden: false, webmcpAvailable: false, registeredCount: 0, lateAttempts: TOOL_SYNC_LATE_ATTEMPTS }),
    ).toBeNull();
  });
  test('WebMCP available with no registered tools: event-driven only', () => {
    expect(nextToolSyncDelay({ hidden: false, webmcpAvailable: true, registeredCount: 0, lateAttempts: 0 })).toBeNull();
  });
  test('registered tools: slow re-check so expired grants get unregistered', () => {
    expect(nextToolSyncDelay({ hidden: false, webmcpAvailable: true, registeredCount: 2, lateAttempts: 0 })).toBe(
      TOOL_SYNC_LIVE_MS,
    );
  });
});
