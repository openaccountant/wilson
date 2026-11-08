// ── Code-split tabs ──────────────────────────────────────────────────────────
//
// Every tab is its own chunk under /_app/, loaded with a dynamic import, so the
// entry chunk the first paint waits on holds only React, the login gate and the
// app shell (header, tab bar, WebMCP provider). Heavy libraries ride with the
// tabs that use them: recharts with the charts, react-markdown with Chat.
//
// main.tsx starts the chunk for the tab in the URL hash before React renders
// (in parallel with the auth check), and once the page is idle every other tab
// is fetched too: a later tab switch is instant, and still works while the
// server is unreachable (the offline mirror keeps serving data then, but a
// chunk that was never fetched could not load).

import { lazy, type ComponentType } from 'react';
import { TAB_IDS, type TabId } from '@webmcp-session';

type TabModule = { default: ComponentType };

const LOADERS: Record<TabId, () => Promise<TabModule>> = {
  overview: () => import('./OverviewTab').then((m) => ({ default: m.OverviewTab })),
  transactions: () => import('./TransactionsTab').then((m) => ({ default: m.TransactionsTab })),
  review: () => import('./ReviewTab').then((m) => ({ default: m.ReviewTab })),
  accounts: () => import('./AccountsTab').then((m) => ({ default: m.AccountsTab })),
  goals: () => import('./GoalsTab').then((m) => ({ default: m.GoalsTab })),
  forecast: () => import('./ForecastTab').then((m) => ({ default: m.ForecastTab })),
  chat: () => import('./ChatTab').then((m) => ({ default: m.ChatTab })),
  llm: () => import('./LlmTab').then((m) => ({ default: m.LlmTab })),
  logs: () => import('./LogsTab').then((m) => ({ default: m.LogsTab })),
  settings: () => import('./SettingsTab').then((m) => ({ default: m.SettingsTab })),
};

/** One in-flight/settled import per tab, shared by prefetch and React.lazy. A failed load is forgotten so a retry refetches. */
const pending = new Map<TabId, Promise<TabModule>>();

export function loadTab(tab: TabId): Promise<TabModule> {
  let p = pending.get(tab);
  if (!p) {
    p = LOADERS[tab]();
    pending.set(tab, p);
    p.catch(() => { if (pending.get(tab) === p) pending.delete(tab); });
  }
  return p;
}

/** Start loading a tab's chunk now; errors surface later through React.lazy, not here. */
export function prefetchTab(tab: TabId): void {
  loadTab(tab).catch(() => { /* reported when the tab renders */ });
}

const lazyTab = (tab: TabId) => lazy(() => loadTab(tab));

export const TAB_COMPONENTS: Record<TabId, ComponentType> = {
  overview: lazyTab('overview'),
  transactions: lazyTab('transactions'),
  review: lazyTab('review'),
  accounts: lazyTab('accounts'),
  goals: lazyTab('goals'),
  forecast: lazyTab('forecast'),
  chat: lazyTab('chat'),
  llm: lazyTab('llm'),
  logs: lazyTab('logs'),
  settings: lazyTab('settings'),
};

/** After the page is idle, fetch the rest of the tabs, one at a time so they never compete with live data requests. */
export function prefetchAllTabsWhenIdle(): void {
  const idle = (cb: () => void) =>
    typeof requestIdleCallback === 'function' ? requestIdleCallback(cb, { timeout: 5_000 }) : setTimeout(cb, 1_500);
  const start = () => {
    const queue = [...TAB_IDS];
    const next = () => {
      const tab = queue.shift();
      if (!tab) return;
      loadTab(tab).catch(() => undefined).finally(() => idle(next));
    };
    idle(next);
  };
  if (document.readyState === 'complete') setTimeout(start, 2_000);
  else window.addEventListener('load', () => setTimeout(start, 2_000), { once: true });
}
