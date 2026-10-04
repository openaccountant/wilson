/**
 * Error classes the tool catalog and its helper modules throw and the engine maps to HTTP statuses.
 * They live here (not in tool-catalog.ts) so a module the catalog imports can throw them without a cycle;
 * tool-catalog.ts re-exports them, so existing imports keep working.
 */

/** A read tool name that is not a read tool. */
export class ToolNotFoundError extends Error {}
/** A target (transaction, interaction, review) does not exist. No operation is created. Maps to 404 `not_found`. */
export class NotFoundError extends Error {}
/** A caller mistake the agent can fix (unknown category, nothing to change). Maps to 400 `invalid_args`. */
export class PrepareError extends Error {}
/** A proposal cites a rubric version that is not the current one. Maps to 409 `rubric_changed`. */
export class RubricChangedError extends Error {
  /** The version the agent must judge by now; the REST body and the bridge's error result carry it as `currentRubricVersion`. */
  constructor(message: string, readonly currentVersion?: string) {
    super(message);
  }
}
