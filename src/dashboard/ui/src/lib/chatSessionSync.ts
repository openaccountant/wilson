/**
 * Tracks which chat session the tab considers open, so the URL -> state
 * reconcile never reloads (and so clears) the conversation the tab itself just
 * created or opened (#183).
 *
 * The id lives in a plain ref-like holder written *synchronously* when the tab
 * adopts it. It must not be re-derived from React state at render: adopting a
 * server-assigned id writes state and the URL together, and the URL store can
 * re-render before the state update commits. A render-derived value would
 * still be the old (null) id then, the effect would see a "foreign" session,
 * reload it, and wipe the just-sent turn.
 */
export interface SessionHolder {
  current: string | null;
}

export type UrlReconcileAction = 'none' | 'load' | 'reset';

/** What the URL -> state effect should do for the current `?session=` value. */
export function reconcileUrlSession(urlSession: string | null, holder: SessionHolder): UrlReconcileAction {
  if (urlSession === holder.current) return 'none';
  return urlSession ? 'load' : 'reset';
}

/** Record the session the tab now owns; call before writing the id to the URL. */
export function adoptSession(holder: SessionHolder, id: string | null): void {
  holder.current = id;
}
