import { describe, expect, test } from 'bun:test';
import { TOKEN_REVEAL_TTL_MS, tokenRevealModel } from '../dashboard/webmcp-token-reveal.js';

/**
 * The one-time reveal of a client token (spec P0b "Show once"). The plaintext
 * must never be rendered while this tab holds a live agent grant, because an
 * agent that can read the page would read it too, and it is wiped after 30 s.
 */

const TOKEN = 'wmcp_SECRETSECRETSECRETSECRETSECRETSECRETSECRET1';

describe('tokenRevealModel', () => {
  test('nothing minted → closed, no token anywhere in the model', () => {
    expect(tokenRevealModel({ token: null, hasLiveGrants: false, revealedAt: null, now: 0 })).toEqual({ kind: 'closed' });
  });

  test('a fresh token with no live grants is shown, with the seconds left', () => {
    const model = tokenRevealModel({ token: TOKEN, hasLiveGrants: false, revealedAt: 1_000, now: 6_000 });
    expect(model).toEqual({ kind: 'shown', token: TOKEN, secondsLeft: 25 });
  });

  test('does not render plaintext while the tab holds live grants: the model has no token field at all', () => {
    const model = tokenRevealModel({ token: TOKEN, hasLiveGrants: true, revealedAt: 1_000, now: 2_000 });
    expect(model.kind).toBe('blocked');
    expect(JSON.stringify(model)).not.toContain(TOKEN);
    expect(JSON.stringify(model)).not.toContain('wmcp_');
    expect(model).toMatchObject({ message: "Revoke this tab's agent grants to reveal a new token" });
  });

  test('the countdown only starts once the token is actually shown, not while it is blocked', () => {
    // Blocked for two minutes, then the user revokes the tab grants: the 30 s start at the reveal.
    const blocked = tokenRevealModel({ token: TOKEN, hasLiveGrants: true, revealedAt: null, now: 120_000 });
    expect(blocked.kind).toBe('blocked');
    const revealed = tokenRevealModel({ token: TOKEN, hasLiveGrants: false, revealedAt: 120_000, now: 121_000 });
    expect(revealed).toMatchObject({ kind: 'shown', secondsLeft: 29 });
  });

  test('after 30 s the token is expired and the model no longer carries it', () => {
    expect(TOKEN_REVEAL_TTL_MS).toBe(30_000);
    const model = tokenRevealModel({ token: TOKEN, hasLiveGrants: false, revealedAt: 0, now: TOKEN_REVEAL_TTL_MS });
    expect(model).toEqual({ kind: 'expired' });
    expect(JSON.stringify(model)).not.toContain(TOKEN);
  });

  test('a live grant appearing while the token is shown hides it again at once', () => {
    const model = tokenRevealModel({ token: TOKEN, hasLiveGrants: true, revealedAt: 0, now: 5_000 });
    expect(model.kind).toBe('blocked');
    expect(JSON.stringify(model)).not.toContain(TOKEN);
  });
});
