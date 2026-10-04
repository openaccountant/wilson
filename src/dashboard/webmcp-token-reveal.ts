/**
 * What the one-time "show once" token reveal may render (spec P0b, T06).
 *
 * A client token's plaintext exists in exactly one place: the response to the
 * mint (or rotate) request. This pure model decides whether the dashboard may
 * put it on screen:
 *
 *  - not while this tab holds ANY live agent grant. An agent that can read the
 *    page (screenshots, the accessibility tree) would read the token as well,
 *    so the reveal waits until the tab's grants are revoked. The "blocked"
 *    state carries no token field at all, so nothing can leak through it;
 *  - not for longer than 30 s once it is actually shown. The caller wipes its
 *    copy of the plaintext when the model says `expired` or `closed`.
 *
 * Import-free and DOM-free: the React Settings tab imports it through the
 * `@webmcp-token-reveal` alias, and root tests import it directly.
 */

/** How long the plaintext stays on screen. */
export const TOKEN_REVEAL_TTL_MS = 30_000;

export const TOKEN_REVEAL_BLOCKED_MESSAGE = "Revoke this tab's agent grants to reveal a new token";

export interface TokenRevealInput {
  /** The plaintext from the mint response, or null when there is nothing to show. */
  token: string | null;
  /** True while this tab holds at least one live agent grant. */
  hasLiveGrants: boolean;
  /** When the plaintext was first shown (ms). Null until it is, so a blocked token does not start the clock. */
  revealedAt: number | null;
  now: number;
}

export type TokenRevealModel =
  | { kind: 'closed' }
  | { kind: 'blocked'; message: string }
  | { kind: 'shown'; token: string; secondsLeft: number }
  | { kind: 'expired' };

export function tokenRevealModel({ token, hasLiveGrants, revealedAt, now }: TokenRevealInput): TokenRevealModel {
  if (token === null) return { kind: 'closed' };
  if (hasLiveGrants) return { kind: 'blocked', message: TOKEN_REVEAL_BLOCKED_MESSAGE };
  const elapsed = revealedAt === null ? 0 : now - revealedAt;
  if (elapsed >= TOKEN_REVEAL_TTL_MS) return { kind: 'expired' };
  return { kind: 'shown', token, secondsLeft: Math.ceil((TOKEN_REVEAL_TTL_MS - elapsed) / 1000) };
}
