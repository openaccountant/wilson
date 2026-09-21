import { describe, expect, test } from 'bun:test';
import {
  RequiresConnectionError,
  classifyWriteError,
  isNetworkError,
  isRequiresConnectionError,
  resolveFetchOutcome,
} from '../dashboard/ui/src/store/offline-writes.js';
import { serveApiPath } from '../dashboard/ui/src/store/mirror-reads.js';
import { createMirrorDb, mirrorTxn, mirrorEntity } from './mirror-helpers.js';
import { applySync } from '../dashboard/ui/src/store/mirror-schema.js';

describe('isNetworkError', () => {
  test('connection-level failures are network errors', () => {
    expect(isNetworkError(new TypeError('Failed to fetch'))).toBe(true);
    expect(isNetworkError(new Error('fetch failed'))).toBe(true);
    expect(isNetworkError(new Error('Load failed'))).toBe(true);
    expect(isNetworkError(Object.assign(new Error('nope'), { name: 'NetworkError' }))).toBe(true);
  });

  test('HTTP-shaped errors are NOT network errors (the server answered)', () => {
    expect(isNetworkError(new Error('API 401: Unauthorized'))).toBe(false);
    expect(isNetworkError(new Error('API 500: Internal Server Error'))).toBe(false);
    expect(isNetworkError(new Error('boom'))).toBe(false);
  });
});

describe('classifyWriteError', () => {
  test('unreachable server → requires-connection', () => {
    expect(classifyWriteError(new RequiresConnectionError())).toBe('requires-connection');
    expect(classifyWriteError(new TypeError('Failed to fetch'))).toBe('requires-connection');
    expect(classifyWriteError(new Error('fetch failed'))).toBe('requires-connection');
  });

  test('server rejections and bugs → failed', () => {
    expect(classifyWriteError(new Error('API 403: Forbidden'))).toBe('failed');
    expect(classifyWriteError(new Error('API 400: Bad Request'))).toBe('failed');
    expect(classifyWriteError('weird')).toBe('failed');
  });
});

describe('RequiresConnectionError', () => {
  test('is a named Error the seam can throw', () => {
    const err = new RequiresConnectionError();
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('RequiresConnectionError');
    expect(err.message).toContain('requires a connection');
  });
});

describe('resolveFetchOutcome', () => {
  const rows = [{ id: 1 }];

  test('GET + network error + mirror has an answer → return-mirror', () => {
    expect(resolveFetchOutcome({ isWrite: false, networkError: true, mirrored: rows })).toBe('return-mirror');
    // An empty array is a real mirror answer (a seeded-but-empty profile).
    expect(resolveFetchOutcome({ isWrite: false, networkError: true, mirrored: [] })).toBe('return-mirror');
  });

  test('GET + network error + mirror cannot serve → throw-requires-connection', () => {
    // An offline GET the mirror cannot serve (unmirrored path, or the mirror is
    // unavailable/never seeded) is "requires connection", not a raw TypeError —
    // the UI renders those as explicitly unavailable offline.
    expect(resolveFetchOutcome({ isWrite: false, networkError: true, mirrored: null })).toBe('throw-requires-connection');
    expect(resolveFetchOutcome({ isWrite: false, networkError: false, mirrored: rows })).toBe('rethrow');
  });

  test('writes always require a connection, even when a mirror answer exists', () => {
    expect(resolveFetchOutcome({ isWrite: true, networkError: true, mirrored: null })).toBe('throw-requires-connection');
    expect(resolveFetchOutcome({ isWrite: true, networkError: true, mirrored: rows })).toBe('throw-requires-connection');
    expect(resolveFetchOutcome({ isWrite: true, networkError: false, mirrored: rows })).toBe('rethrow');
  });
});

describe('isRequiresConnectionError', () => {
  test('true only for the seam\'s explicit error', () => {
    expect(isRequiresConnectionError(new RequiresConnectionError())).toBe(true);
    expect(isRequiresConnectionError(new TypeError('Failed to fetch'))).toBe(false);
    expect(isRequiresConnectionError(new Error('API 500: boom'))).toBe(false);
    expect(isRequiresConnectionError(null)).toBe(false);
    expect(isRequiresConnectionError('offline')).toBe(false);
  });
});

describe('serveApiPath routing', () => {
  test('returns null for unmirrored paths so the caller keeps the original error', async () => {
    const db = await createMirrorDb();
    await applySync(db, {
      profile: 'default',
      transactions: [mirrorTxn({ id: 1, external_id: 'e' }) as never],
      entities: [mirrorEntity() as never],
      budgets: [],
      categories: [],
    });
    for (const path of [
      '/api/alerts',          // engine is server-side → unavailable offline
      '/api/net-worth',       // accounts table is not mirrored
      '/api/cashflow/monthly',// out of approved offline scope
      '/api/entities/1',
      '/api/transactions/12', // single-row write path, not the list route
      '/unknown',
    ]) {
      expect(await serveApiPath(db, path)).toBeNull();
    }
  });
});