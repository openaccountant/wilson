import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { AGENT_ACCESS_HINT, isLoopbackHost, signInBlockedReason, whatThisIs } from '../dashboard/ui/src/lib/signInCopy.js';

/** #193: the sign-in page says what this is, what Agent access is, and why Sign in is disabled. Copy only. */

describe('sign-in copy', () => {
  test('says what Wilson is; "this computer" only when the page really is served from this computer', () => {
    expect(whatThisIs('localhost')).toBe("Your household's money dashboard. Runs on this computer.");
    expect(whatThisIs('127.0.0.1')).toBe("Your household's money dashboard. Runs on this computer.");
    expect(whatThisIs('[::1]')).toContain('Runs on this computer.');
    // Opened from another device on the home network (an auth-on LAN bind): not "this" computer.
    expect(whatThisIs('192.168.1.20')).not.toContain('this computer');
    expect(whatThisIs('192.168.1.20')).toContain('not in the cloud');
    expect(isLoopbackHost('127.0.0.1.evil.example')).toBe(false);
  });

  test('says why Sign in is disabled, and nothing once both fields are filled', () => {
    expect(signInBlockedReason('', '')).toBe('Enter your username and password.');
    expect(signInBlockedReason('   ', '')).toBe('Enter your username and password.');
    expect(signInBlockedReason('ann', '')).toBe('Enter your password.');
    expect(signInBlockedReason('', 'pw')).toBe('Enter your username.');
    expect(signInBlockedReason('ann', 'pw')).toBeNull();
  });

  test('the Agent access hint promises only what the app enforces (NN-03, NN-04)', () => {
    expect(AGENT_ACCESS_HINT).toContain('Agent access');
    expect(AGENT_ACCESS_HINT).toMatch(/no tools unless they are granted/);
    expect(AGENT_ACCESS_HINT).toMatch(/approve/);
  });

  test('the login form still refuses to submit without both fields (the hint is the same rule, not a weaker one)', () => {
    const src = readFileSync(new URL('../dashboard/ui/src/components/AuthGate.tsx', import.meta.url), 'utf8');
    expect(src).toContain('disabled={busy || blocked !== null}');
    expect(src).toMatch(/async function submit\(\) \{\s+if \(blocked\) return;/);
  });
});
