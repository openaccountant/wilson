/**
 * Stale-response guard for imperative fetches (the drill's 'N more'
 * expansion): every scope change invalidates the tokens handed out before it,
 * so a response that lands after the scope/path moved on is ignored instead
 * of overwriting the new view. Pure; no `window`.
 */
export interface RequestGate {
  /** Start a request for `scope`; returns its token. */
  begin(scope: string): number;
  /** True when `token` is the latest request AND its scope is still current. */
  isCurrent(token: number, scope: string): boolean;
  /** The scope changed: every outstanding token goes stale. */
  reset(scope: string): void;
}

export function createRequestGate(initialScope = ''): RequestGate {
  let scope = initialScope;
  let latest = 0;
  return {
    begin(s: string) {
      if (s !== scope) scope = s;
      latest += 1;
      return latest;
    },
    isCurrent(token: number, s: string) {
      return token === latest && s === scope;
    },
    reset(s: string) {
      scope = s;
      latest += 1;
    },
  };
}
