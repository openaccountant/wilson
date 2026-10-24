/**
 * Guards the production-bundle fix for `wilson --dashboard` white-screening on
 * load: csv-parse (pulled into the browser build by the statement parsers in
 * src/tools/import/parsers/) references the bare Node `Buffer` global. The
 * app is code-split (mobile LCP, NN-10), so csv-parse only loads with the
 * chunks that import the statement parsers, and the shim rides with them: it
 * must be the first import of every UI module that imports `@import-tools/*`
 * (ES modules run their imports in order, so anything imported ahead of it
 * could reach csv-parse before `globalThis.Buffer` exists). Dev mode never
 * reproduces this (esbuild's CJS pre-bundling differs), so nothing else would
 * catch a regression.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const UI_SRC = new URL('../dashboard/ui/src/', import.meta.url);

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sources(p);
    return /\.(ts|tsx)$/.test(name) ? [p] : [];
  });
}

describe('dashboard Buffer polyfill', () => {
  test("every module that imports the statement parsers imports '@/buffer-shim' first", () => {
    const root = UI_SRC.pathname;
    const importers = sources(root).filter((p) => /from '@import-tools\//.test(readFileSync(p, 'utf8')));
    expect(importers.length).toBeGreaterThan(0);
    for (const p of importers) {
      const firstImport = readFileSync(p, 'utf8').split('\n').find((line) => line.startsWith('import '));
      expect({ file: relative(root, p), firstImport }).toEqual({ file: relative(root, p), firstImport: "import '@/buffer-shim';" });
    }
  });

  test('the entry (main.tsx) does not carry the Buffer polyfill any more', () => {
    const main = readFileSync(new URL('main.tsx', UI_SRC), 'utf8');
    expect(main).not.toContain('buffer-shim');
  });

  test('the shim installs Buffer only when the global is missing', () => {
    const shim = readFileSync(new URL('buffer-shim.ts', UI_SRC), 'utf8');
    expect(shim).toContain("from 'buffer'");
    expect(shim).toMatch(/typeof \(globalThis as [^)]*\)\.Buffer === 'undefined'/);
  });
});
