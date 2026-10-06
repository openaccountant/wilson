import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { TAB_IDS } from '../dashboard/webmcp-session.js';

/**
 * The dashboard's tab ids live in one place (`TAB_IDS`, webmcp-session.ts). The tab bar, the app's hash router
 * and the server's tab-scoped tool surfaces all read it. Same approach as the theme parity test: read the sources
 * and fail if one of them grows its own list.
 */

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const stripComments = (code: string) => code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('TAB_IDS', () => {
  test('is the ten dashboard tabs, in tab-bar order', () => {
    expect([...TAB_IDS]).toEqual(['overview', 'transactions', 'review', 'accounts', 'goals', 'forecast', 'chat', 'llm', 'logs', 'settings']);
  });

  test('TabBar.tsx and App.tsx import TAB_IDS and declare no own list', () => {
    for (const file of ['../dashboard/ui/src/components/TabBar.tsx', '../dashboard/ui/src/App.tsx']) {
      const code = stripComments(read(file));
      expect(code, file).toMatch(/from '@webmcp-session'/);
      expect(code, file).toContain('TAB_IDS');
      // No literal that lists two or more tab ids side by side (an array of ids, or `{ id: 'x' }` entries).
      for (const a of TAB_IDS) {
        for (const b of TAB_IDS) {
          if (a === b) continue;
          expect(code, `${file} lists '${a}' next to '${b}'`).not.toMatch(new RegExp(`'${a}'\\s*,\\s*'${b}'`));
        }
        expect(code, `${file} declares an id entry for '${a}'`).not.toMatch(new RegExp(`id:\\s*'${a}'`));
      }
    }
  });

  test('the vite and tsc aliases resolve @webmcp-session, @webmcp-registry, @declarative-submit and @webmcp-page-tools', () => {
    const vite = read('../dashboard/ui/vite.config.ts');
    const tsconfig = read('../dashboard/ui/tsconfig.json');
    for (const alias of ['@webmcp-session', '@webmcp-registry', '@declarative-submit', '@webmcp-page-tools']) {
      expect(vite).toContain(`'${alias}'`);
      expect(tsconfig).toContain(`"${alias}"`);
    }
  });
});
