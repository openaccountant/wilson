import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { embeddedFile, extractEmbeddedDir, isCompiledBinary, readEmbeddedText } from '../utils/embedded-assets.js';

afterEach(() => {
  globalThis.__WILSON_EMBEDDED__ = undefined;
});

function fakeManifest(files: Record<string, string>) {
  const src = mkdtempSync(join(tmpdir(), 'embedded-src-'));
  const mapped: Record<string, string> = {};
  let i = 0;
  for (const [rel, text] of Object.entries(files)) {
    const p = join(src, `f${i++}`);
    writeFileSync(p, text);
    mapped[rel] = p;
  }
  globalThis.__WILSON_EMBEDDED__ = { buildId: `test-${Date.now()}`, files: mapped };
}

describe('embedded assets', () => {
  test('from source there is no manifest: every lookup is null', async () => {
    expect(isCompiledBinary()).toBe(false);
    expect(embeddedFile('src/dashboard/ui/dist/index.html')).toBeNull();
    expect(await readEmbeddedText('SOUL.md')).toBeNull();
    expect(extractEmbeddedDir('src/skills', mkdtempSync(join(tmpdir(), 'embedded-out-')))).toBeNull();
  });

  test('reads an embedded text file by its repo path', async () => {
    fakeManifest({ 'SOUL.md': 'hello soul' });
    expect(isCompiledBinary()).toBe(true);
    expect(await readEmbeddedText('SOUL.md')).toBe('hello soul');
    expect(await readEmbeddedText('missing.md')).toBeNull();
  });

  test('extracts a directory tree, keeping its layout, and only that prefix', () => {
    fakeManifest({
      'src/skills/tax-prep/SKILL.md': 'tax',
      'src/skills/nested/debt/SKILL.md': 'debt',
      'src/skillsfoo/other.md': 'not under src/skills/',
      'src/orchestration/chains/a.yaml': 'name: a',
    });
    const out = mkdtempSync(join(tmpdir(), 'embedded-out-'));
    const dir = extractEmbeddedDir('src/skills', out)!;
    expect(dir).toBe(join(out, globalThis.__WILSON_EMBEDDED__!.buildId, 'src', 'skills'));
    expect(readFileSync(join(dir, 'tax-prep', 'SKILL.md'), 'utf8')).toBe('tax');
    expect(readFileSync(join(dir, 'nested', 'debt', 'SKILL.md'), 'utf8')).toBe('debt');
    expect(existsSync(join(out, globalThis.__WILSON_EMBEDDED__!.buildId, 'src', 'skillsfoo'))).toBe(false);
    expect(existsSync(join(out, globalThis.__WILSON_EMBEDDED__!.buildId, 'src', 'orchestration'))).toBe(false);
  });

  test('a prefix with nothing embedded under it is null', () => {
    fakeManifest({ 'SOUL.md': 'x' });
    expect(extractEmbeddedDir('src/dashboard/ui/dist-hybrid', mkdtempSync(join(tmpdir(), 'embedded-out-')))).toBeNull();
  });
});
