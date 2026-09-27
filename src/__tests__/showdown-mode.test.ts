import { describe, expect, test } from 'bun:test';
import {
  resolveCloudMode,
  probeOpenRouterNetwork,
  OPENROUTER_PROBE_URL,
  OPENROUTER_PROBE_TIMEOUT_MS,
} from '../demo/showdown.js';

describe('resolveCloudMode', () => {
  test('live only when the key is present AND the network probe passed', () => {
    expect(resolveCloudMode({ hasKey: true, networkOk: true })).toBe('live');
  });

  test('every other key×network outcome degrades to simulated', () => {
    expect(resolveCloudMode({ hasKey: true, networkOk: false })).toBe('simulated');
    expect(resolveCloudMode({ hasKey: true, networkOk: null })).toBe('simulated');
    expect(resolveCloudMode({ hasKey: false, networkOk: true })).toBe('simulated');
    expect(resolveCloudMode({ hasKey: false, networkOk: false })).toBe('simulated');
    expect(resolveCloudMode({ hasKey: false, networkOk: null })).toBe('simulated');
  });

  test('a missing key short-circuits without needing a probe outcome', () => {
    // networkOk null = probe never ran — that alone must never produce 'live'.
    expect(resolveCloudMode({ hasKey: false, networkOk: null })).toBe('simulated');
  });
});

describe('probeOpenRouterNetwork', () => {
  function stubFetch(impl: (input: string, init?: RequestInit) => Promise<Response>): typeof fetch {
    return (async (input: string | URL | Request, init?: RequestInit) =>
      impl(String(input), init)) as unknown as typeof fetch;
  }

  test('HTTP 2xx → true, and probes the OpenRouter models endpoint', async () => {
    let seenUrl = '';
    const ok = await probeOpenRouterNetwork(
      stubFetch(async (input) => {
        seenUrl = input;
        return new Response('{"data":[]}', { status: 200 });
      }),
    );
    expect(ok).toBe(true);
    expect(seenUrl).toBe(OPENROUTER_PROBE_URL);
  });

  test('non-2xx → false', async () => {
    const ok = await probeOpenRouterNetwork(
      stubFetch(async () => new Response('rate limited', { status: 429 })),
    );
    expect(ok).toBe(false);
  });

  test('rejecting fetch (DNS failure, offline) → false', async () => {
    const ok = await probeOpenRouterNetwork(
      stubFetch(async () => {
        throw new Error('getaddrinfo ENOTFOUND');
      }),
    );
    expect(ok).toBe(false);
  });

  test('never-resolving fetch + short timeout → false (abort respected)', async () => {
    const never = ((_input: unknown, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('The operation was aborted')));
      })) as unknown as typeof fetch;
    const ok = await probeOpenRouterNetwork(never, 10);
    expect(ok).toBe(false);
  });

  test('probe constants match the real OpenRouter base URL and a sane timeout', () => {
    expect(OPENROUTER_PROBE_URL).toBe('https://openrouter.ai/api/v1/models');
    expect(OPENROUTER_PROBE_TIMEOUT_MS).toBe(2500);
  });
});