import { createContext, useCallback, useContext, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { bindPageHandlers, getPageRegistry, type PageToolHandler } from '@webmcp-registry';
import type { TabId } from '@webmcp-session';
import { availableToolsFor, buildPageContext, navigateRefusalResult, parseTab, settleWithin, tabRefusalResult, waitForActiveTab, type PageContextContribution } from '@webmcp-page-tools';
import { useAppState } from '@/state';
import { useApi } from '@/hooks/useApi';
import { armPageGuard } from '@/agent/agentGuard';
import type { CategoryRow } from '@/types';

/**
 * Registers the dashboard's global page tools (`open_tab`, `get_page_context`) for the life of the app, and tells
 * the page registry which tab is showing. The in-page bridge owns `registerTool` and the authorization (grant, policy,
 * kill switch, rate limit, audit all happen on the server before a handler runs); this component only owns what the
 * tools DO to the page, and the intent behind them.
 *
 * Rendered by App around `<main>`, inside the app state, so no context reaches above the tab content.
 */

interface WebMcpContextValue {
  /** A tab says what only it knows (its search text, a selected row, how many rows it lists). `null` withdraws it. */
  publish(tab: TabId, contribution: PageContextContribution | null): void;
}

const WebMcpContext = createContext<WebMcpContextValue | null>(null);

function registryOf() {
  return getPageRegistry(window as unknown as Parameters<typeof getPageRegistry>[0]);
}

const NAVIGATE_TIMEOUT_MS = 1000;

export function WebMcpProvider({ activeTab, onNavigate, children }: { activeTab: TabId; onNavigate: (tab: TabId) => void; children: ReactNode }) {
  const app = useAppState();
  const appRef = useRef(app);
  appRef.current = app;
  // Category rows tell a system name from a custom one (an agent may have created the custom one): get_page_context only
  // echoes a category filter through the same label rules as every other category an agent reads.
  const { data: categoryRows } = useApi<CategoryRow[]>('/api/categories');
  const categoriesRef = useRef<CategoryRow[]>([]);
  categoriesRef.current = categoryRows ?? [];
  const tabRef = useRef(activeTab);
  tabRef.current = activeTab;
  const navigateRef = useRef(onNavigate);
  navigateRef.current = onNavigate;
  const contributions = useRef(new Map<TabId, PageContextContribution>());

  // The tab now showing. The bridge reconciles on this (a tab's tools are registered only while it shows).
  useEffect(() => {
    registryOf().setActiveTab(activeTab);
  }, [activeTab]);

  const handlers = useMemo<Record<string, PageToolHandler>>(
    () => ({
      open_tab: async (args, { signal }) => {
        // Refusals are RESULTS ({ error: { code, message } }), never thrown: Chrome 154 hides a thrown message from the agent.
        const tab = parseTab(args.tab);
        if (!tab) return tabRefusalResult(args.tab);
        const registry = registryOf();
        // Settings is off limits both ways: never pull the user out of it (their edits would be lost).
        const refusal = navigateRefusalResult(registry.activeTab(), tab);
        if (refusal) return refusal;
        if (registry.activeTab() !== tab) {
          // The same route a click takes (hash, then state). Wait until the tab really shows, then until the bridge has
          // swapped the registered tools, so the list below is true by the time the agent reads it.
          // Guard before the switch too, so the new tab never renders with live buttons under the pointer (T16).
          armPageGuard();
          navigateRef.current(tab);
          await waitForActiveTab(registry, tab, signal, NAVIGATE_TIMEOUT_MS);
          // Bounded too: a registration that never settles must not leave this call hanging.
          await settleWithin(registry.whenSettled?.(), NAVIGATE_TIMEOUT_MS);
          // The new tab is now under the pointer: its human action buttons stay off for a moment (T16).
          armPageGuard();
        }
        return { tab, tools: availableToolsFor(registry, tab) };
      },
      get_page_context: async () => {
        const { dateRange, accountId, category, entityId } = appRef.current;
        const tab = tabRef.current;
        return buildPageContext({ tab, dateRange, accountId, category, entityId, categories: categoriesRef.current, contribution: contributions.current.get(tab) });
      },
    }),
    []
  );

  // App lifetime: one AbortController, aborted on unmount (and by React's dev double-mount).
  useEffect(() => bindPageHandlers(registryOf(), 'global', Object.keys(handlers), () => handlers), [handlers]);

  const publish = useCallback((tab: TabId, contribution: PageContextContribution | null) => {
    if (contribution) contributions.current.set(tab, contribution);
    else contributions.current.delete(tab);
  }, []);
  const value = useMemo(() => ({ publish }), [publish]);

  return <WebMcpContext.Provider value={value}>{children}</WebMcpContext.Provider>;
}

/**
 * A tab publishes what only it knows, for `get_page_context`: its own filters, the selected row, how many rows it lists.
 * Ids, counts and filter values: never a description or an amount. Withdrawn when the tab unmounts. A no-op outside
 * the provider.
 */
export function usePageContext(tab: TabId, contribution: PageContextContribution): void {
  const ctx = useContext(WebMcpContext);
  const key = JSON.stringify(contribution);
  useEffect(() => {
    ctx?.publish(tab, JSON.parse(key) as PageContextContribution);
    return () => ctx?.publish(tab, null);
  }, [ctx, tab, key]);
}
