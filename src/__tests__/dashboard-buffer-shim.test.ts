/**
 * Guards the production-bundle fix for `wilson --dashboard` white-screening on
 * load: csv-parse (pulled into the browser build by the statement parsers in
 * src/tools/import/parsers/) references the bare Node `Buffer` global. The
 * shim must be the first module main.tsx evaluates — ES modules run their
 * imports in order, so anything imported ahead of it could reach csv-parse
 * before `globalThis.Buffer` exists. Dev mode never reproduces this (esbuild's
 * CJS pre-bundling differs), so nothing else would catch a regression.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const UI_SRC = new URL('../dashboard/ui/src/', import.meta.url);

describe('dashboard Buffer polyfill', () => {
  test("main.tsx imports './buffer-shim' before anything else", () => {
    const main = readFileSync(new URL('main.tsx', UI_SRC), 'utf8');
    const firstImport = main.split('\n').find((line) => line.startsWith('import '));
    expect(firstImport).toBe("import './buffer-shim';");
  });

  test('the shim installs Buffer only when the global is missing', () => {
    const shim = readFileSync(new URL('buffer-shim.ts', UI_SRC), 'utf8');
    expect(shim).toContain("from 'buffer'");
    expect(shim).toMatch(/typeof \(globalThis as [^)]*\)\.Buffer === 'undefined'/);
  });
});
