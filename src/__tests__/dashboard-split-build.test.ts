// @invariant NN-10
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TAB_IDS } from '../dashboard/webmcp-session.js';

/**
 * Mobile LCP (NN-10): the dashboard used to inline its whole React build, wa-sqlite wasm (base64, twice) and
 * all, into one ~3 MB index.html, so a phone parsed every tab before the first paint. Now index.html only
 * names content-hashed files under /_app/, every tab is its own chunk, recharts loads after the Overview's
 * text, and the mirror worker and its wasm are separate files.
 */

const ROOT = new URL('../..', import.meta.url).pathname;
const UI = join(ROOT, 'src/dashboard/ui');
const DIST = join(UI, 'dist');
const built = existsSync(join(DIST, 'index.html')) && existsSync(join(DIST, '_app'));

describe('vite config', () => {
  const config = readFileSync(join(UI, 'vite.config.ts'), 'utf8');

  test('no singlefile inlining; hashed output under _app with nothing base64-inlined', () => {
    expect(config).not.toContain('vite-plugin-singlefile');
    expect(config).not.toContain('viteSingleFile(');
    expect(config).toMatch(/assetsDir:\s*APP_ASSETS_DIR/);
    expect(config).toMatch(/const APP_ASSETS_DIR = '_app'/);
    expect(config).toMatch(/assetsInlineLimit:\s*0/);
  });

  test('the mirror worker is its own file, not an inline blob', () => {
    const client = readFileSync(join(UI, 'src/store/mirror-client.ts'), 'utf8');
    expect(client).toContain("from './mirror-worker.ts?worker'");
    expect(client).not.toContain('?worker&inline');
  });
});

describe.skipIf(!built)('built output (only when `bun run build` ran)', () => {
  const html = built ? readFileSync(join(DIST, 'index.html'), 'utf8') : '';
  const files = built ? readdirSync(join(DIST, '_app')) : [];
  const read = (name: string) => readFileSync(join(DIST, '_app', name), 'utf8');

  test('index.html no longer inlines the bundle: tiny, no inline script or style bodies', () => {
    expect(html.length).toBeLessThan(4_000);
    expect(html).toMatch(/<script type="module" crossorigin src="\/_app\/index-[A-Za-z0-9_-]{8,}\.js"><\/script>/);
    expect(html).toMatch(/<link rel="stylesheet" crossorigin href="\/_app\/index-[A-Za-z0-9_-]{8,}\.css">/);
    expect(html).not.toMatch(/<script[^>]*>[^<]+<\/script>/); // every script is src= only
    expect(html).not.toMatch(/<style[\s>]/);
    expect(html).not.toContain('base64');
  });

  test('every emitted file is content-hashed', () => {
    expect(files.length).toBeGreaterThan(10);
    for (const f of files) expect(f).toMatch(/-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/);
  });

  test('the wasm is a file of its own, never base64 in a chunk', () => {
    expect(files.some((f) => /^wa-sqlite-.*\.wasm$/.test(f))).toBe(true);
    for (const f of files.filter((n) => n.endsWith('.js'))) {
      expect({ f, inlined: read(f).includes('data:application/wasm;base64') }).toEqual({ f, inlined: false });
    }
  });

  test('tabs are split: the entry chunk holds no tab and no recharts / react-markdown', () => {
    const entryName = html.match(/src="\/_app\/(index-[^"]+\.js)"/)![1];
    const entry = read(entryName);
    // Each tab is a separate dynamically imported chunk.
    for (const tab of ['OverviewTab', 'TransactionsTab', 'ChatTab', 'SettingsTab', 'ForecastTab', 'LlmTab']) {
      expect(files.some((f) => f.startsWith(`${tab}-`))).toBe(true);
      expect(entry).toMatch(new RegExp(`import\\("\\./${tab}-[A-Za-z0-9_-]+\\.js"\\)`));
    }
    expect(entry).not.toContain('recharts-wrapper'); // recharts' root class name
    expect(entry).not.toContain('micromark'); // react-markdown's parser
  });

  test('the Overview chunk does not pull recharts in statically', () => {
    const overview = read(files.find((f) => f.startsWith('OverviewTab-'))!);
    const staticImports = [...overview.matchAll(/from"\.\/([^"]+)"/g)].map((m) => m[1]);
    for (const dep of staticImports) {
      expect({ dep, recharts: read(dep).includes('recharts-wrapper') }).toEqual({ dep, recharts: false });
    }
  });

  test('the model runtime and open-jev stay out of every chunk (guard reads the split build)', async () => {
    const gate = (await import(new URL('../../scripts/check-hybrid-build.ts', import.meta.url).pathname)) as {
      readReactBuild(distDir: string): string | null;
    };
    const all = gate.readReactBuild(DIST)!;
    for (const f of files.filter((n) => n.endsWith('.js'))) expect(all).toContain(read(f).slice(0, 200));
    expect(all.toLowerCase()).not.toContain('onnxruntime');
    expect(all).not.toMatch(/\bOpenJev\b/);
  });
});

describe('readReactBuild (scripts/check-hybrid-build.ts)', () => {
  test('includes chunk contents, so a runtime hidden in a lazy chunk fails the gate', async () => {
    const gate = (await import(new URL('../../scripts/check-hybrid-build.ts', import.meta.url).pathname)) as {
      readReactBuild(distDir: string): string | null;
      checkHybridBuild(input: { indexHtml: string; hybridJs: string; hybridEntries: string[] }): string[];
    };
    const dist = mkdtempSync(join(tmpdir(), 'oa-split-'));
    try {
      expect(gate.readReactBuild(dist)).toBeNull();
      writeFileSync(join(dist, 'index.html'), '<script type="module" src="/_app/index-AbCdEf12.js"></script>');
      mkdirSync(join(dist, '_app'));
      writeFileSync(join(dist, '_app', 'ChatTab-AbCdEf12.js'), 'const x = "onnxruntime-web";');
      const text = gate.readReactBuild(dist)!;
      expect(text).toContain('onnxruntime-web');
      const problems = gate.checkHybridBuild({ indexHtml: text, hybridJs: '', hybridEntries: [] });
      expect(problems.some((p) => p.includes('onnxruntime'))).toBe(true);
    } finally {
      rmSync(dist, { recursive: true, force: true });
    }
  });
});

// Loaded in a child process (helpers/load-lazy-ui.ts): the Vite-suffix stub it needs is a global bun plugin, and here
// it would also replace the mirror worker that mirror-client-wipe-race.test.ts mocks.
let lazyUi: Promise<{ registry: string[]; tabs: Record<string, string>; sharedImport: boolean; charts: Record<string, string> }> | undefined;
function loadLazyUi() {
  lazyUi ??= (async () => {
    const proc = Bun.spawn(['bun', 'run', join(ROOT, 'src/__tests__/helpers/load-lazy-ui.ts')], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    if (code !== 0) throw new Error(`load-lazy-ui exited ${code}: ${err}`);
    return JSON.parse(out.trim().split('\n').at(-1) ?? '{}');
  })();
  return lazyUi;
}

describe('lazy tabs and charts', () => {
  test('every tab id has a loader that resolves to its component', async () => {
    const { registry, tabs, sharedImport } = await loadLazyUi();
    expect(registry).toEqual([...TAB_IDS].sort());
    expect(tabs).toEqual({
      overview: 'OverviewTab',
      transactions: 'TransactionsTab',
      review: 'ReviewTab',
      accounts: 'AccountsTab',
      goals: 'GoalsTab',
      forecast: 'ForecastTab',
      chat: 'ChatTab',
      llm: 'LlmTab',
      logs: 'LogsTab',
      settings: 'SettingsTab',
    });
    // One import per tab: prefetch and React.lazy share it.
    expect(sharedImport).toBe(true);
  });

  test('App renders the active tab through the lazy registry inside <Suspense>', () => {
    const app = readFileSync(join(UI, 'src/App.tsx'), 'utf8');
    expect(app).toContain("import { TAB_COMPONENTS } from '@/tabs/lazyTabs'");
    expect(app).not.toMatch(/from '@\/tabs\/\w+Tab'/);
    expect(app).toMatch(/<Suspense fallback=\{<TabLoading \/>\}>\s*<ActiveTabComponent \/>\s*<\/Suspense>/);
    const main = readFileSync(join(UI, 'src/main.tsx'), 'utf8');
    expect(main).toContain('prefetchTab(parseHash(window.location.hash).tab)');
    expect(main).toContain('prefetchAllTabsWhenIdle()');
  });

  test('the Overview charts load on demand and resolve to components', async () => {
    expect((await loadLazyUi()).charts).toEqual({
      SavingsSparklineChart: 'function',
      CashflowFanChart: 'function',
      SpendingDonut: 'function',
    });
    for (const f of ['components/SavingsSparkline.tsx', 'components/CashflowForecast.tsx', 'components/spending/SpendingLevel1.tsx']) {
      const src = readFileSync(join(UI, 'src', f), 'utf8');
      expect({ f, recharts: src.includes("from 'recharts'") }).toEqual({ f, recharts: false });
      expect(src).toContain("from '@/charts/lazyCharts'");
      expect(src).toContain('<Suspense fallback={null}>');
    }
  });
});

describe('npm package', () => {
  test('a "files" allowlist, when present, still ships the hashed build (src/dashboard/ui/dist/_app)', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { files?: string[] };
    if (!pkg.files) return; // no allowlist: npm packs everything not ignored
    const target = 'src/dashboard/ui/dist/_app/index-AbCdEf12.js';
    const includes = pkg.files.filter((f) => !f.startsWith('!')).some((f) => target.startsWith(f.replace(/^\.\//, '').replace(/\*\*?.*$/, '')));
    const excludes = pkg.files.filter((f) => f.startsWith('!')).some((f) => target.startsWith(f.slice(1).replace(/^\.\//, '')));
    expect(includes && !excludes).toBe(true);
  });
});
