import { describe, test, expect, spyOn, beforeEach, afterEach } from 'bun:test';
import * as license from '../licensing/license.js';
import { fetchPaidSkillContent, fetchPaidChainSteps, clearContentCache } from '../content/fetcher.js';
import { existsSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const CACHE_DIR = join(homedir(), '.openaccountant', 'content-cache');

function writeCacheFile(type: 'skills' | 'chains', name: string, content: string): void {
  const ext = type === 'skills' ? '.md' : '.json';
  const dir = join(CACHE_DIR, type);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}${ext}`), content);
}

describe('content/fetcher', () => {
  let fetchSpy: ReturnType<typeof spyOn>;
  let licenseSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    // Default: no license
    licenseSpy = spyOn(license, 'getLicenseInfo').mockReturnValue(null);
  });

  afterEach(() => {
    fetchSpy?.mockRestore();
    licenseSpy?.mockRestore();
  });

  describe('fetchPaidSkillContent', () => {
    test('returns null when no license', async () => {
      const result = await fetchPaidSkillContent('test-skill');
      expect(result).toBeNull();
    });

    test('returns content on success', async () => {
      licenseSpy.mockReturnValue({ key: 'test-key', email: 'a@b.com', products: [], validUntil: '2030-01-01', validatedAt: '2026-01-01' });
      fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('# Skill Instructions\nDo stuff', { status: 200 }),
      );

      const result = await fetchPaidSkillContent('test-skill');
      expect(result).toBe('# Skill Instructions\nDo stuff');
    });

    test('returns null on 401', async () => {
      licenseSpy.mockReturnValue({ key: 'test-key', email: 'a@b.com', products: [], validUntil: '2030-01-01', validatedAt: '2026-01-01' });
      fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('Unauthorized', { status: 401 }),
      );

      const result = await fetchPaidSkillContent('test-skill');
      expect(result).toBeNull();
    });

    test('returns null on 403', async () => {
      licenseSpy.mockReturnValue({ key: 'test-key', email: 'a@b.com', products: [], validUntil: '2030-01-01', validatedAt: '2026-01-01' });
      fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('Forbidden', { status: 403 }),
      );

      const result = await fetchPaidSkillContent('test-skill');
      expect(result).toBeNull();
    });

    test('falls back to cache on 500', async () => {
      licenseSpy.mockReturnValue({ key: 'test-key', email: 'a@b.com', products: [], validUntil: '2030-01-01', validatedAt: '2026-01-01' });
      fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('Internal Server Error', { status: 500 }),
      );

      // No cache exists, should return null
      const result = await fetchPaidSkillContent('nonexistent-skill-xyz');
      expect(result).toBeNull();
    });

    test('falls back to cache on network error', async () => {
      licenseSpy.mockReturnValue({ key: 'test-key', email: 'a@b.com', products: [], validUntil: '2030-01-01', validatedAt: '2026-01-01' });
      fetchSpy = spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network error'));

      const result = await fetchPaidSkillContent('nonexistent-skill-xyz');
      expect(result).toBeNull();
    });
  });

  describe('fetchPaidChainSteps', () => {
    test('returns null when no license', async () => {
      const result = await fetchPaidChainSteps('test-chain');
      expect(result).toBeNull();
    });

    test('returns steps on success', async () => {
      licenseSpy.mockReturnValue({ key: 'test-key', email: 'a@b.com', products: [], validUntil: '2030-01-01', validatedAt: '2026-01-01' });
      fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ steps: [{ id: 'step1' }, { id: 'step2' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      const result = await fetchPaidChainSteps('test-chain');
      expect(result).toEqual([{ id: 'step1' }, { id: 'step2' }]);
    });

    test('returns null on 401', async () => {
      licenseSpy.mockReturnValue({ key: 'test-key', email: 'a@b.com', products: [], validUntil: '2030-01-01', validatedAt: '2026-01-01' });
      fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('Unauthorized', { status: 401 }),
      );

      const result = await fetchPaidChainSteps('test-chain');
      expect(result).toBeNull();
    });

    test('returns null on 403', async () => {
      licenseSpy.mockReturnValue({ key: 'test-key', email: 'a@b.com', products: [], validUntil: '2030-01-01', validatedAt: '2026-01-01' });
      fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('Forbidden', { status: 403 }),
      );

      const result = await fetchPaidChainSteps('test-chain');
      expect(result).toBeNull();
    });

    test('falls back to cache on network error', async () => {
      licenseSpy.mockReturnValue({ key: 'test-key', email: 'a@b.com', products: [], validUntil: '2030-01-01', validatedAt: '2026-01-01' });
      fetchSpy = spyOn(globalThis, 'fetch').mockRejectedValue(new Error('DNS failed'));

      const result = await fetchPaidChainSteps('nonexistent-chain-xyz');
      expect(result).toBeNull();
    });
  });

  describe('fetchPaidSkillContent (cache fallback)', () => {
    afterEach(() => {
      // Clean up test cache files
      const skillCache = join(CACHE_DIR, 'skills', 'cache-test-skill.md');
      try { rmSync(skillCache); } catch {}
    });

    test('falls back to cache on server error when cache exists', async () => {
      // Write a cache file first
      writeCacheFile('skills', 'cache-test-skill', '# Cached skill content');

      licenseSpy.mockReturnValue({ key: 'test-key', email: 'a@b.com', products: [], validUntil: '2030-01-01', validatedAt: '2026-01-01' });
      fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('Internal Server Error', { status: 500 }),
      );

      const result = await fetchPaidSkillContent('cache-test-skill');
      expect(result).toBe('# Cached skill content');
    });

    test('falls back to cache on network error when cache exists', async () => {
      writeCacheFile('skills', 'cache-test-skill', '# Cached network fallback');

      licenseSpy.mockReturnValue({ key: 'test-key', email: 'a@b.com', products: [], validUntil: '2030-01-01', validatedAt: '2026-01-01' });
      fetchSpy = spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));

      const result = await fetchPaidSkillContent('cache-test-skill');
      expect(result).toBe('# Cached network fallback');
    });
  });

  describe('fetchPaidChainSteps (cache fallback)', () => {
    afterEach(() => {
      const chainCache = join(CACHE_DIR, 'chains', 'cache-test-chain.json');
      try { rmSync(chainCache); } catch {}
    });

    test('falls back to cache on server error when cache exists', async () => {
      writeCacheFile('chains', 'cache-test-chain', JSON.stringify([{ id: 'cached-step' }]));

      licenseSpy.mockReturnValue({ key: 'test-key', email: 'a@b.com', products: [], validUntil: '2030-01-01', validatedAt: '2026-01-01' });
      fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('Server Error', { status: 500 }),
      );

      const result = await fetchPaidChainSteps('cache-test-chain');
      expect(result).toEqual([{ id: 'cached-step' }]);
    });

    test('falls back to cache on network error when cache exists', async () => {
      writeCacheFile('chains', 'cache-test-chain', JSON.stringify({ steps: [{ id: 'net-cached' }] }));

      licenseSpy.mockReturnValue({ key: 'test-key', email: 'a@b.com', products: [], validUntil: '2030-01-01', validatedAt: '2026-01-01' });
      fetchSpy = spyOn(globalThis, 'fetch').mockRejectedValue(new Error('DNS failed'));

      const result = await fetchPaidChainSteps('cache-test-chain');
      expect(result).toEqual([{ id: 'net-cached' }]);
    });

    test('returns null on network error with corrupt cache JSON', async () => {
      writeCacheFile('chains', 'cache-test-chain', '{not valid json}}}');

      licenseSpy.mockReturnValue({ key: 'test-key', email: 'a@b.com', products: [], validUntil: '2030-01-01', validatedAt: '2026-01-01' });
      fetchSpy = spyOn(globalThis, 'fetch').mockRejectedValue(new Error('DNS failed'));

      const result = await fetchPaidChainSteps('cache-test-chain');
      expect(result).toBeNull();
    });

    test('caches successful response for later use', async () => {
      licenseSpy.mockReturnValue({ key: 'test-key', email: 'a@b.com', products: [], validUntil: '2030-01-01', validatedAt: '2026-01-01' });
      fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ steps: [{ id: 'fresh-step' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      const result = await fetchPaidChainSteps('cache-test-chain');
      expect(result).toEqual([{ id: 'fresh-step' }]);

      // Verify cache file was written
      const cachePath = join(CACHE_DIR, 'chains', 'cache-test-chain.json');
      expect(existsSync(cachePath)).toBe(true);
    });
  });

  describe('clearContentCache', () => {
    test('does not throw when cache dir does not exist', () => {
      expect(() => clearContentCache()).not.toThrow();
    });

    test('removes cache directory when it exists', () => {
      // Create a cache file
      writeCacheFile('skills', 'clear-test', '# test');
      expect(existsSync(CACHE_DIR)).toBe(true);

      clearContentCache();
      expect(existsSync(CACHE_DIR)).toBe(false);
    });
  });
});
