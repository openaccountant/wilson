// Loads the dashboard's lazy tab and chart modules under bun and prints what they resolve to as JSON.
// Run in its own process by dashboard-split-build.test.ts: the Vite-suffix stub below is a global bun plugin, and
// in the test process it would also replace the mirror worker that mirror-client-wipe-race.test.ts mocks.
import { plugin } from 'bun';
import { TAB_IDS } from '../../dashboard/webmcp-session.js';

// The tab modules import Vite-only specifiers (`?worker`, `?url`); stand them in so bun can load the real modules.
plugin({
  name: 'vite-suffix-stubs',
  setup(build) {
    build.onResolve({ filter: /\?(worker|worker&inline|url)$/ }, (args) => ({ path: args.path, namespace: 'vite-suffix-stub' }));
    build.onLoad({ filter: /.*/, namespace: 'vite-suffix-stub' }, (args) => ({
      contents: args.path.endsWith('?url') ? 'export default "/_app/stub.wasm";' : 'export default class StubWorker {}',
      loader: 'js',
    }));
  },
});

const UI_SRC = new URL('../../dashboard/ui/src/', import.meta.url);
const lazyTabs = (await import(new URL('tabs/lazyTabs.ts', UI_SRC).pathname)) as {
  TAB_COMPONENTS: Record<string, unknown>;
  loadTab(tab: string): Promise<{ default: { name: string } }>;
};

const tabs: Record<string, string> = {};
for (const tab of TAB_IDS) {
  const mod = await lazyTabs.loadTab(tab);
  tabs[tab] = typeof mod.default === 'function' ? mod.default.name : `not a component: ${typeof mod.default}`;
}

const charts: Record<string, string> = {};
for (const name of ['SavingsSparklineChart', 'CashflowFanChart', 'SpendingDonut']) {
  const mod = (await import(new URL(`charts/${name}.tsx`, UI_SRC).pathname)) as Record<string, unknown>;
  charts[name] = typeof mod[name];
}

console.log(JSON.stringify({
  registry: Object.keys(lazyTabs.TAB_COMPONENTS).sort(),
  tabs,
  // One import per tab: prefetch and React.lazy share it.
  sharedImport: lazyTabs.loadTab('chat') === lazyTabs.loadTab('chat'),
  charts,
}));
