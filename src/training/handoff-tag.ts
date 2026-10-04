/**
 * The per-profile secret behind the handoff block tag, and the detectors built on it.
 *
 * A real handoff block carries `k=<tag>` in its header and end marker, where tag is the first 16 hex characters of
 * HMAC-SHA256(secret, 'wilson-handoff-v1\n' + body). Only the server holds the secret, so text a user types or
 * pastes, or a model echoes, can never be a block (see local-handoff-format.ts for the scan and
 * handoff-block.ts for the judge view and the export check).
 *
 * Storage: two rows of the profile DB's existing `dashboard_config` key-value table (no new table, no migration):
 *  - `handoff_secret`: 32 random bytes, hex;
 *  - `handoff_tag_since`: `datetime('now')` at creation. Rows recorded before it were written when blocks had no tag
 *    and keep the old untagged detection (fail-safe: more is a block than should be, never less).
 * Both are created by `ensureHandoffSecret`, eagerly in `initDatabase` (every entry point: CLI, headless, dashboard), again in `initChatSession`, and otherwise when a block is built.
 * A profile that existed before this shipped gets its `since` at its first open: rows recorded earlier stay legacy by design (their prompts were never tagged, so the old untagged detection is the only correct reading). Reads never write. The secret is
 * never returned by any API, export or judge read: nothing but this module selects the `handoff_secret` row.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Database } from '../db/compat-sqlite.js';
import {
  HANDOFF_DETECT_LEGACY,
  HANDOFF_TAG_CHARS,
  HANDOFF_TAG_DOMAIN,
  type HandoffDetector,
} from '../dashboard/local-handoff-format.js';

const SECRET_KEY = 'handoff_secret';
const SINCE_KEY = 'handoff_tag_since';
const SECRET_RE = /^[0-9a-f]{64}$/;

export interface HandoffTagState {
  secret: Buffer;
  /** SQLite `datetime('now')` form (UTC, 'YYYY-MM-DD HH:MM:SS'), comparable with `llm_interactions.created_at`. */
  since: string;
}

/** The first 16 hex characters of HMAC-SHA256(secret, domain + body). */
export function handoffTag(secret: Buffer, body: string): string {
  return createHmac('sha256', secret).update(HANDOFF_TAG_DOMAIN).update(body).digest('hex').slice(0, HANDOFF_TAG_CHARS);
}

function verifierFor(secret: Buffer) {
  return (body: string, tag: string): boolean => {
    if (tag.length !== HANDOFF_TAG_CHARS) return false;
    const want = Buffer.from(handoffTag(secret, body));
    const got = Buffer.from(tag);
    return want.length === got.length && timingSafeEqual(want, got);
  };
}

// The secret never changes once written, so a read that found it can be remembered for that Database object.
const cache = new WeakMap<Database, HandoffTagState>();

/** Read-only. Null when no block was ever built in this profile (then nothing tagged can exist). */
export function readHandoffTagState(db: Database): HandoffTagState | null {
  const hit = cache.get(db);
  if (hit) return hit;
  try {
    const rows = db.prepare('SELECT key, value FROM dashboard_config WHERE key IN (@s, @t)').all({ s: SECRET_KEY, t: SINCE_KEY }) as Array<{ key: string; value: string }>;
    const secret = rows.find((r) => r.key === SECRET_KEY)?.value;
    const since = rows.find((r) => r.key === SINCE_KEY)?.value;
    if (!secret || !since || !SECRET_RE.test(secret)) return null;
    const state = { secret: Buffer.from(secret, 'hex'), since };
    cache.set(db, state);
    return state;
  } catch {
    return null;
  }
}

/** Create the secret and the since-timestamp if they are missing (idempotent, safe under a race), then return them. */
export function ensureHandoffSecret(db: Database): HandoffTagState {
  const existing = readHandoffTagState(db);
  if (existing) return existing;
  // Since first: a reader that sees the secret always sees the timestamp too.
  db.prepare(`INSERT OR IGNORE INTO dashboard_config (key, value) VALUES (@t, datetime('now'))`).run({ t: SINCE_KEY });
  // A malformed secret (hand-edited) is replaced; a good one is kept.
  db.prepare('DELETE FROM dashboard_config WHERE key = @s AND NOT (length(value) = 64 AND value NOT GLOB \'*[^0-9a-f]*\')').run({ s: SECRET_KEY });
  db.prepare('INSERT OR IGNORE INTO dashboard_config (key, value) VALUES (@s, @v)').run({ s: SECRET_KEY, v: randomBytes(32).toString('hex') });
  const state = readHandoffTagState(db);
  if (!state) throw new Error('handoff secret could not be stored');
  return state;
}

/**
 * The detector for one recorded row (or for replay when `createdAt` is null: a message in this process is always
 * recent). No secret yet: every row is legacy. Otherwise rows older than `since` are legacy, and the rest accept
 * tagged, verified blocks only.
 */
export function detectorFor(state: HandoffTagState | null, createdAt?: string | null): HandoffDetector {
  if (!state) return HANDOFF_DETECT_LEGACY;
  if (typeof createdAt === 'string' && createdAt < state.since) return HANDOFF_DETECT_LEGACY;
  return { acceptLegacy: false, verify: verifierFor(state.secret) };
}

export function detectorFromDb(db: Database, createdAt?: string | null): HandoffDetector {
  return detectorFor(readHandoffTagState(db), createdAt);
}

/** True when the row belongs to the legacy era (pre-tag or no secret). */
export function isLegacyDetector(d: HandoffDetector): boolean {
  return d.acceptLegacy;
}

// ── Replay (chat history, agent) ─────────────────────────────────────────────

let replayDb: Database | null = null;

/** The chat DB whose secret the replay and agent code verify against. Set where the chat DB is set. */
export function setHandoffReplayDb(db: Database | null): void {
  replayDb = db;
}

/** The detector for text that is replayed in this process: tagged-only once the profile has a secret. */
export function replayDetector(): HandoffDetector {
  return replayDb ? detectorFromDb(replayDb) : HANDOFF_DETECT_LEGACY;
}
