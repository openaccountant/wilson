import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { THEME } from '../dashboard/webmcp-theme.js';

/**
 * The vanilla bridge cannot use Tailwind, so it carries Forensic Noir as
 * constants. They must stay equal to the dashboard's own tokens.
 */
const css = readFileSync(join(import.meta.dir, '../dashboard/ui/src/styles/app.css'), 'utf8');

function token(name: string): string {
  const match = css.match(new RegExp(`--${name}:\\s*([^;]+);`));
  if (!match) throw new Error(`token --${name} not found in app.css`);
  return match[1].trim();
}

describe('webmcp-theme', () => {
  test('theme constants match the app.css tokens', () => {
    expect(THEME.bg).toBe(token('color-surface-raised'));
    expect(THEME.surface).toBe(token('color-surface'));
    expect(THEME.border).toBe(token('color-border'));
    expect(THEME.text).toBe(token('color-text'));
    expect(THEME.muted).toBe(token('color-text-muted'));
    expect(THEME.green).toBe(token('color-green'));
    expect(THEME.red).toBe(token('color-red'));
    expect(THEME.amber).toBe(token('color-yellow'));
    expect(THEME.mono).toBe(token('font-mono').replace(/^'JetBrains Mono'/, "'JetBrains Mono'"));
  });

  test('the panel is square-ish Forensic Noir: 6px radius, no pill', () => {
    expect(THEME.radius).toBe('6px');
  });

  test('the theme module has no imports', () => {
    const src = readFileSync(join(import.meta.dir, '../dashboard/webmcp-theme.ts'), 'utf8');
    expect(src).not.toMatch(/^\s*import\s/m);
  });
});
