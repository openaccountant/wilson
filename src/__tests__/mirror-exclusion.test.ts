import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isMirrorExcluded, serveApiPath } from '../dashboard/ui/src/store/mirror-reads.js';

/**
 * Offline mode must never show stale "agent access enabled" data: nothing
 * under /api/mcp/ is ever served from the OPFS mirror (P1, UI data access).
 */
describe('mirror exclusion', () => {
  test('every /api/mcp/ path is excluded, with or without a query string', () => {
    for (const p of ['/api/mcp/state', '/api/mcp/state?x=1', '/api/mcp/policies', '/api/mcp/audit?limit=50', '/api/mcp/operations/abc', '/api/mcp/']) {
      expect(isMirrorExcluded(p)).toBe(true);
    }
    for (const p of ['/api/transactions', '/api/mcpx', '/api/summary?start=1', '/mcp']) {
      expect(isMirrorExcluded(p)).toBe(false);
    }
  });

  test('serveApiPath refuses an excluded path outright, even before it looks at the database', async () => {
    const neverTouched = new Proxy({}, { get() { throw new Error('the database must not be read'); } });
    expect(await serveApiPath(neverTouched as any, '/api/mcp/state')).toBeNull();
  });

  test('tryMirror short-circuits on the same predicate (source check)', () => {
    const src = readFileSync(join(import.meta.dir, '../dashboard/ui/src/store/mirror-client.ts'), 'utf8');
    expect(src).toContain('isMirrorExcluded');
  });
});
