import { useEffect, useRef } from 'react';
import { bindPageHandlers, getPageRegistry, type PageToolHandler } from '@webmcp-registry';
import type { TabId } from '@webmcp-session';

/**
 * A tab registers the handlers of its page tools while it is mounted. The in-page bridge owns `registerTool`: it
 * shows a tab's tools to the agent only while this tab is the one showing AND a handler is mounted, and the server
 * has already authorized the call before a handler runs. When the tab unmounts, the one AbortController made for
 * this mount aborts, the handlers disappear from the registry, and the bridge unregisters the tools.
 *
 * `handlers` may be a new object every render: the registered wrapper calls the latest one, so a handler always sees
 * current state without re-registering (which would make the tool flicker).
 */
export function useWebMcpPageTools(tab: TabId, handlers: Record<string, PageToolHandler>): void {
  const latest = useRef(handlers);
  latest.current = handlers;
  const names = Object.keys(handlers).sort().join(',');

  useEffect(() => {
    const registry = getPageRegistry(window as unknown as Parameters<typeof getPageRegistry>[0]);
    return bindPageHandlers(registry, tab, names.split(','), () => latest.current);
  }, [tab, names]);
}
