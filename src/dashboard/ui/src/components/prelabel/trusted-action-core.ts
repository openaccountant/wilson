/**
 * Speed bump for one-click accepts (specs/open-jev-labeler.md §10.2).
 *
 * A control is enabled only 800 ms after it was armed, and only an event with
 * `isTrusted === true` is accepted. This stops a scripted `.click()` and an
 * accidental double-click. It is NOT proof of a human: input dispatched over the
 * Chrome DevTools Protocol (Playwright, browser-driving agents) arrives with
 * `isTrusted === true` too. Pure and clock-injected so bun can test it.
 */

export const TRUSTED_ACTION_DELAY_MS = 800;

export interface TrustedAction {
  /** Start (or restart) the delay. */
  arm(): void;
  /** Block until armed again. */
  disarm(): void;
  /** True once the delay has elapsed since the last arm(). Timer only; ignores trust. */
  isEnabled(): boolean;
  /** True when the click may proceed: enabled AND `isTrusted`. */
  accepts(ev: { isTrusted: boolean }): boolean;
}

export function createTrustedAction(deps: { now(): number; delayMs?: number }): TrustedAction {
  const delay = deps.delayMs ?? TRUSTED_ACTION_DELAY_MS;
  let armedAt: number | null = null;
  const isEnabled = () => armedAt !== null && deps.now() - armedAt >= delay;
  return {
    arm() {
      armedAt = deps.now();
    },
    disarm() {
      armedAt = null;
    },
    isEnabled,
    accepts(ev) {
      return ev.isTrusted === true && isEnabled();
    },
  };
}
