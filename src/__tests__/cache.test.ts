import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import * as os from 'os';
import { buildCacheKey, describeRequest, readCache, writeCache } from '../utils/cache.js';
import { setActiveProfilePaths, resetActiveProfile } from '../profile/index.js';

describe('cache utilities', () => {
  // Pure function tests — no filesystem needed
  describe('buildCacheKey', () => {
    test('is deterministic (same inputs → same output)', () => {
      const key1 = buildCacheKey('/prices/', { ticker: 'AAPL', interval: 'day' });
      const key2 = buildCacheKey('/prices/', { ticker: 'AAPL', interval: 'day' });
      expect(key1).toBe(key2);
    });

    test('is order-independent for params', () => {
      const key1 = buildCacheKey('/prices/', { ticker: 'AAPL', interval: 'day', limit: '30' });
      const key2 = buildCacheKey('/prices/', { limit: '30', interval: 'day', ticker: 'AAPL' });
      expect(key1).toBe(key2);
    });

    test('includes ticker prefix when present', () => {
      const key = buildCacheKey('/prices/', { ticker: 'AAPL' });
      expect(key).toContain('AAPL_');
    });

    test('no ticker prefix when absent', () => {
      const key = buildCacheKey('/search/', { query: 'earnings' });
      expect(key).not.toContain('_');
      expect(key).toMatch(/^search\//);
    });

    test('cleans endpoint slashes', () => {
      const key = buildCacheKey('/prices/', { ticker: 'GOOG' });
      expect(key).toMatch(/^prices\//);
    });

    test('different params produce different keys', () => {
      const key1 = buildCacheKey('/prices/', { ticker: 'AAPL' });
      const key2 = buildCacheKey('/prices/', { ticker: 'GOOG' });
      expect(key1).not.toBe(key2);
    });

    test('filters out undefined/null params', () => {
      const key1 = buildCacheKey('/prices/', { ticker: 'AAPL', limit: undefined });
      const key2 = buildCacheKey('/prices/', { ticker: 'AAPL' });
      expect(key1).toBe(key2);
    });

    test('output ends with .json', () => {
      const key = buildCacheKey('/prices/', { ticker: 'AAPL' });
      expect(key).toMatch(/\.json$/);
    });
  });

  describe('describeRequest', () => {
    test('includes ticker in parentheses', () => {
      const desc = describeRequest('/prices/', { ticker: 'AAPL' });
      expect(desc).toBe('/prices/ (AAPL)');
    });

    test('includes extra params sorted alphabetically', () => {
      const desc = describeRequest('/prices/', { ticker: 'AAPL', interval: 'day', limit: 30 });
      expect(desc).toBe('/prices/ (AAPL) interval=day limit=30');
    });

    test('works without ticker', () => {
      const desc = describeRequest('/search/', { query: 'earnings' });
      expect(desc).toBe('/search/ query=earnings');
    });

    test('skips undefined params', () => {
      const desc = describeRequest('/search/', { query: 'test', limit: undefined });
      expect(desc).toBe('/search/ query=test');
    });

    test('endpoint only when no params', () => {
      const desc = describeRequest('/health/', {});
      expect(desc).toBe('/health/');
    });

    test('array params joined with commas', () => {
      const desc = describeRequest('/multi/', { tags: ['a', 'b', 'c'] });
      expect(desc).toBe('/multi/ tags=a,b,c');
    });
  });

  describe('readCache/writeCache roundtrip', () => {
    const tmpDir = join(os.tmpdir(), `cache-test-${Date.now()}`);

    beforeAll(() => {
      mkdirSync(tmpDir, { recursive: true });
      // Point the active profile's cache dir at our temp dir
      setActiveProfilePaths({
        name: 'test',
        root: tmpDir,
        database: join(tmpDir, 'data.db'),
        settings: join(tmpDir, 'settings.json'),
        scratchpad: join(tmpDir, 'scratchpad'),
        cache: join(tmpDir, 'cache'),
      });
    });

    afterAll(() => {
      resetActiveProfile();
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    });

    test('cache miss returns null', () => {
      const result = readCache('/nonexistent/', { key: 'value' });
      expect(result).toBeNull();
    });

    test('write then read returns same data', () => {
      const endpoint = '/test-roundtrip/';
      const params = { ticker: 'TEST', ts: String(Date.now()) };
      const data = { price: 150.5, volume: 1000 };
      const url = 'https://api.example.com/test';

      writeCache(endpoint, params, data, url);
      const cached = readCache(endpoint, params);

      expect(cached).not.toBeNull();
      expect(cached!.data).toEqual(data);
      expect(cached!.url).toBe(url);
    });

    test('different params miss cache', () => {
      const endpoint = '/test-miss/';
      const params1 = { ticker: 'AAA', ts: String(Date.now()) };
      const params2 = { ticker: 'BBB', ts: String(Date.now()) };

      writeCache(endpoint, params1, { val: 1 }, 'url1');
      const cached = readCache(endpoint, params2);
      expect(cached).toBeNull();
    });
  });
});
