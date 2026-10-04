/**
 * The page registry: how the in-page WebMCP bridge (a vanilla bundle injected into every page) and the React
 * dashboard (a separate vite bundle) agree on which agent tools are live right now.
 *
 * The bridge asks the server (`/api/mcp/tools`) what this tab may use (granted, policy not Off, kill switch on),
 * and publishes the answer here. A declarative form reads it to decide whether to carry `toolname`,
 * `tooldescription` and `toolparamdescription` at all: no live tool, no attributes, so a form is never
 * discoverable by an agent that was not granted it. The server stays authoritative; this only decides what
 * the DOM advertises.
 *
 * It also carries the page tools' handlers (P3). The bridge owns `registerTool`; React owns what a page tool does.
 * A tab registers its handlers while it is mounted (`registerHandler`, aborted on unmount) and the provider says
 * which tab shows (`setActiveTab`), so the bridge can register a tab's tools only while that tab shows and a handler
 * is there, and a call that arrives after the tab is gone finds no handler instead of touching unmounted state.
 *
 * Both bundles contain their own copy of this module, so the registry is a singleton on `window`
 * (`__wilsonPageTools`), not on the module. Import-free and DOM-free: Bun.build bundles it for the bridge,
 * vite for React (alias `@webmcp-registry`), and root tests import it directly.
 */

/** What a form needs to advertise a live tool; a slice of the server's `/api/mcp/tools` row. */
export interface LiveToolInfo {
  name: string;
  description: string;
  /** `read` | `mutating` | `proposal` | `page`, as the server classified it. */
  classification: string;
  /** Only ever true for a read or page tool (a catalog test enforces it; `declarativeAttrs` checks again). */
  autosubmit: boolean;
  /**
   * The user's effective policy for the tool (`off` tools are never live). Absent (an older server): forms treat it as
   * `ask`, so an agent's form values are held back until a server outcome authorizes them (fail closed).
   */
  policy?: 'allow' | 'ask';
  /** The catalog's JSON Schema: types for coercing form values, descriptions for `toolparamdescription`. */
  inputSchema: unknown;
  /** `global`, or `{ tab }` for a tool that exists only while that tab shows. Absent: global. */
  surface?: 'global' | { tab: string };
  /** `imperative` tools are registered by the bridge, `declarative` ones are exposed by their form. Absent: imperative. */
  exposure?: 'imperative' | 'declarative';
}

/**
 * What React does for a page tool once the server has authorized the call: change what the tab shows and
 * answer the agent. `pageData` is the server's own answer (a row it read), when the tool has one.
 * `signal` aborts when the agent gives up or the tab goes away.
 */
export interface PageToolHandler {
  (args: Record<string, unknown>, ctx: { signal: AbortSignal; pageData?: unknown }): Promise<unknown>;
}

/** A registered handler. `tab` is a dashboard tab id, or `global` for one that lives as long as the app. */
export interface PageHandlerEntry {
  tab: string;
  handler: PageToolHandler;
  signal: AbortSignal;
}

export interface PageRegistry {
  /** Granted, policy not Off, and agent access on. Published by the bridge. */
  isToolLive(name: string): boolean;
  /** A copy: nothing outside the bridge can change the live set through it. */
  liveTools(): ReadonlySet<string>;
  /** Metadata for a live tool (undefined when it is not live). */
  toolInfo(name: string): LiveToolInfo | undefined;
  /**
   * Bridge only. Replaces the live set; `info` carries the metadata forms advertise. Notifies subscribers, but ONLY when
   * something changed: an equal re-publish keeps every info object (so `toolInfo` is identity-stable across the bridge's
   * 5 s resync) and tells nobody, and a change to one tool replaces only that tool's object. A form that re-reads its
   * attributes, or a tool that is re-registered, because of a no-op publish would make Chrome cancel a running call
   * ('Tool execution cancelled, since tool definition was updated').
   */
  setLiveTools(names: Iterable<string>, info?: Iterable<LiveToolInfo>): void;
  /**
   * Set by the bridge: one call into the server's single tool endpoint, with the tab's session and the live
   * grant. `agentCall: true` for a declarative form's `agentInvoked` submit: the bridge then tracks the call and the
   * operations IT creates, so that Chrome's `toolcancel` can withdraw them. A person's own submit leaves it off. Resolves with a read's data, a page tool's answer, or a change's outcome after the human answered.
   */
  callServerTool?: (
    name: string,
    args: unknown,
    opts: { signal?: AbortSignal; transport: 'declarative' | 'page'; agentCall?: boolean }
  ) => Promise<unknown>;
  subscribe(fn: () => void): () => void;
  /** React: the tab now showing. Notifies subscribers (the bridge reconciles) only when it changed. */
  setActiveTab(tab: string): void;
  activeTab(): string | undefined;
  /**
   * React: the handler for a page tool. Removed when `signal` aborts (the component unmounted), so a tab's
   * handler never outlives its state. A second registration under the same name replaces the first.
   */
  registerHandler(name: string, tab: string, handler: PageToolHandler, signal: AbortSignal): void;
  /** The live handler for `name`: not aborted, and either global or belonging to the tab that is showing. */
  getHandler(name: string): PageHandlerEntry | undefined;
  /**
   * Set by the bridge: flush any pending registration change now and resolve once the tools match the live set.
   * `open_tab` waits on it so its answer is true by the time the agent reads it.
   */
  whenSettled?: () => Promise<void>;
}

export const REGISTRY_WINDOW_KEY = '__wilsonPageTools';

/** Key order never matters to a digest: a schema that is the same content in another key order is the same schema. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

/** Everything about a live tool that a form advertises or acts on. Equal digest, same tool as far as the page can tell. */
export function liveInfoDigest(info: LiveToolInfo): string {
  return stableStringify(info);
}

function createRegistry(): PageRegistry {
  let live = new Set<string>();
  let infos = new Map<string, LiveToolInfo>();
  const subscribers = new Set<() => void>();
  const handlers = new Map<string, PageHandlerEntry>();
  let active: string | undefined;

  const notify = () => {
    for (const fn of [...subscribers]) {
      try {
        fn();
      } catch {
        // One broken subscriber must not stop the others from learning a tool was revoked.
      }
    }
  };

  return {
    isToolLive: (name) => live.has(name),
    liveTools: () => new Set(live),
    toolInfo: (name) => (live.has(name) ? infos.get(name) : undefined),
    setLiveTools(names, info) {
      const nextLive = new Set(names);
      const nextInfos = new Map<string, LiveToolInfo>();
      let changed = nextLive.size !== live.size || [...nextLive].some((name) => !live.has(name));
      for (const entry of info ?? []) {
        if (!nextLive.has(entry.name)) continue;
        const before = infos.get(entry.name);
        // Same content: keep the object the forms already hold.
        if (before && liveInfoDigest(before) === liveInfoDigest(entry)) {
          nextInfos.set(entry.name, before);
        } else {
          nextInfos.set(entry.name, entry);
          changed = true;
        }
      }
      if (nextInfos.size !== infos.size) changed = true;
      live = nextLive;
      infos = nextInfos;
      if (changed) notify();
    },
    subscribe(fn) {
      subscribers.add(fn);
      return () => {
        subscribers.delete(fn);
      };
    },
    setActiveTab(tab) {
      if (active === tab) return;
      active = tab;
      notify();
    },
    activeTab: () => active,
    registerHandler(name, tab, handler, signal) {
      if (signal.aborted) return;
      const entry: PageHandlerEntry = { tab, handler, signal };
      handlers.set(name, entry);
      signal.addEventListener(
        'abort',
        () => {
          // Only the registration that is still current: a newer one for the same name stays.
          if (handlers.get(name) !== entry) return;
          handlers.delete(name);
          notify();
        },
        { once: true }
      );
      notify();
    },
    getHandler(name) {
      const entry = handlers.get(name);
      if (!entry || entry.signal.aborted) return undefined;
      if (entry.tab !== 'global' && entry.tab !== active) return undefined;
      return entry;
    },
  };
}

/**
 * What a tab component does on mount: register `names` for `tab` under one AbortController, and return the
 * function that aborts it (unmount). The registered wrapper calls whatever `latest()` holds at call time,
 * so a re-render with new state never needs a re-registration.
 */
export function bindPageHandlers(
  registry: Pick<PageRegistry, 'registerHandler'>,
  tab: string,
  names: readonly string[],
  latest: () => Record<string, PageToolHandler | undefined>
): () => void {
  const controller = new AbortController();
  for (const name of names) {
    registry.registerHandler(
      name,
      tab,
      (args, ctx) => {
        const handler = latest()[name];
        // A result, not a rejection: Chrome would replace a thrown message with a generic error.
        if (!handler) return Promise.resolve({ error: { code: 'unavailable', message: `${name} is not available right now.` } });
        return handler(args, ctx);
      },
      controller.signal
    );
  }
  return () => controller.abort();
}

/** Get-or-create the singleton on `w` (pass `window`). Two copies of this module share one registry. */
export function getPageRegistry(w: { __wilsonPageTools?: PageRegistry }): PageRegistry {
  if (!w.__wilsonPageTools) w.__wilsonPageTools = createRegistry();
  return w.__wilsonPageTools;
}
