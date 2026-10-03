/** S5: trusted-action speed bump (specs/open-jev-labeler.md §10.2, §14). */
import { describe, test, expect } from 'bun:test';
import { createTrustedAction, TRUSTED_ACTION_DELAY_MS } from '../dashboard/ui/src/components/prelabel/trusted-action-core.js';

function make() {
  const clock = { t: 10_000 };
  const a = createTrustedAction({ now: () => clock.t });
  return { a, clock };
}

describe('createTrustedAction', () => {
  test('the delay is 800 ms', () => {
    expect(TRUSTED_ACTION_DELAY_MS).toBe(800);
  });

  test('a click before 800 ms is ignored', () => {
    const { a, clock } = make();
    a.arm();
    clock.t += 799;
    expect(a.accepts({ isTrusted: true })).toBe(false);
  });

  test('a click at 800 ms is accepted', () => {
    const { a, clock } = make();
    a.arm();
    clock.t += 800;
    expect(a.accepts({ isTrusted: true })).toBe(true);
  });

  test('isTrusted:false is ignored even after the delay', () => {
    const { a, clock } = make();
    a.arm();
    clock.t += 5000;
    expect(a.accepts({ isTrusted: false })).toBe(false);
  });

  test('never armed -> never accepts', () => {
    const { a, clock } = make();
    clock.t += 5000;
    expect(a.accepts({ isTrusted: true })).toBe(false);
  });

  test('re-arming restarts the delay', () => {
    const { a, clock } = make();
    a.arm();
    clock.t += 1000;
    a.arm();
    clock.t += 100;
    expect(a.accepts({ isTrusted: true })).toBe(false);
    clock.t += 700;
    expect(a.accepts({ isTrusted: true })).toBe(true);
  });

  test('disarm blocks until armed again', () => {
    const { a, clock } = make();
    a.arm();
    clock.t += 1000;
    a.disarm();
    expect(a.accepts({ isTrusted: true })).toBe(false);
  });

  test('isEnabled reflects the timer only (the UI uses it to un-grey the button)', () => {
    const { a, clock } = make();
    expect(a.isEnabled()).toBe(false);
    a.arm();
    expect(a.isEnabled()).toBe(false);
    clock.t += 800;
    expect(a.isEnabled()).toBe(true);
  });

  test('a custom delay', () => {
    const clock = { t: 0 };
    const a = createTrustedAction({ now: () => clock.t, delayMs: 100 });
    a.arm();
    clock.t = 99;
    expect(a.accepts({ isTrusted: true })).toBe(false);
    clock.t = 100;
    expect(a.accepts({ isTrusted: true })).toBe(true);
  });
});
