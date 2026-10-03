/**
 * Dashboard chat "@" mentions → a context block the agent can act on.
 *
 * The browser sends `{type, id?, key?, label}` per mention. Nothing the client
 * says is trusted: every entity is re-read from the DB by id (or, for
 * merchants, must exist in transactions), and the block uses the DB's labels.
 * The block is prepended to the query so the ids survive chat-history reloads
 * (the UI strips it again with stripContextBlock before rendering).
 */
import type { Database } from '../db/compat-sqlite.js';
import { getAccountById } from '../db/net-worth-queries.js';
import { getGoalById } from '../db/goal-queries.js';
import { getEntityById } from '../db/entity-queries.js';

export const MENTION_TYPES = ['account', 'category', 'merchant', 'goal', 'entity'] as const;
export type MentionType = (typeof MENTION_TYPES)[number];

export interface MentionRef {
  type: MentionType;
  id?: number;
  key?: string;
  label: string;
}

export const MAX_MENTIONS = 10;
export const MAX_MENTION_LABEL = 120;
export const MAX_MERCHANT_LABEL = 60;
/** Raw merchant keys (merchant_name or a bank description) are matched exactly, so allow long ones. */
export const MAX_MERCHANT_KEY = 500;

export const CONTEXT_BLOCK_HEADER =
  '[Referenced entities — resolved by the dashboard; use these ids with tools]';

export type ValidateMentionsResult = { ok: true; mentions: MentionRef[] } | { ok: false; error: string };

/**
 * Shape-check the request's `mentions`. Absent → []. Present but not an
 * array → error (400). Otherwise invalid entries are dropped silently and at
 * most MAX_MENTIONS valid ones are kept.
 */
export function validateMentions(raw: unknown): ValidateMentionsResult {
  if (raw === undefined || raw === null) return { ok: true, mentions: [] };
  if (!Array.isArray(raw)) return { ok: false, error: 'mentions must be an array' };

  const out: MentionRef[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (out.length >= MAX_MENTIONS) break;
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.type !== 'string' || !(MENTION_TYPES as readonly string[]).includes(e.type)) continue;
    const type = e.type as MentionType;
    const label = typeof e.label === 'string' ? e.label.slice(0, MAX_MENTION_LABEL) : '';

    if (type === 'merchant') {
      const key = typeof e.key === 'string' && e.key ? e.key.slice(0, MAX_MERCHANT_KEY) : label;
      if (!key) continue;
      const dedupe = `merchant:${key}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      out.push({ type, key, label: label || key });
      continue;
    }

    if (typeof e.id !== 'number' || !Number.isInteger(e.id) || e.id <= 0) continue;
    const dedupe = `${type}:${e.id}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    out.push({ type, id: e.id, label });
  }
  return { ok: true, mentions: out };
}

/** Strip control chars (incl. newlines), brackets and quotes; collapse whitespace; cap length. */
export function sanitizeMerchantLabel(raw: string): string {
  return raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/[[\]"]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_MERCHANT_LABEL)
    .trim();
}

/** DB text is quoted inside the block — keep it on one line, no stray quotes. */
function q(s: string): string {
  return sanitizeInline(s).replace(/"/g, "'");
}

function sanitizeInline(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim();
}

function formatMoney(n: number): string {
  return Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`;
}

function resolveOne(db: Database, m: MentionRef): string | null {
  switch (m.type) {
    case 'account': {
      const a = getAccountById(db, m.id!);
      if (!a) return null;
      const inst = [a.institution, a.account_number_last4 ? `••${a.account_number_last4}` : null]
        .filter(Boolean)
        .join(' ');
      const detail = [inst, `${a.account_type}/${a.account_subtype}`].filter(Boolean).join(', ');
      return `- account id=${a.id} "${q(a.name)}" (${sanitizeInline(detail)})`;
    }
    case 'category': {
      const c = db.prepare('SELECT id, name, slug FROM categories WHERE id = @id').get({ id: m.id! }) as
        | { id: number; name: string; slug: string }
        | undefined;
      if (!c) return null;
      const budget = db
        .prepare('SELECT monthly_limit FROM budgets WHERE LOWER(category) IN (LOWER(@name), LOWER(@slug)) LIMIT 1')
        .get({ name: c.name, slug: c.slug }) as { monthly_limit: number } | undefined;
      const suffix = budget ? ` (budget ${formatMoney(budget.monthly_limit)}/mo)` : '';
      return `- category id=${c.id} slug=${c.slug} "${q(c.name)}"${suffix}`;
    }
    case 'merchant': {
      // Match on the raw key the menu got from /api/merchants (TRIM(merchant_name)
      // or description) — the sanitized label is display-only and can differ
      // (brackets, quotes, >60 chars), so it would never match.
      const key = m.key ?? m.label;
      if (!key.trim()) return null;
      const hit = db
        .prepare('SELECT 1 AS ok FROM transactions WHERE TRIM(merchant_name) = @key OR description = @key LIMIT 1')
        .get({ key });
      if (!hit) return null;
      const label = sanitizeMerchantLabel(key);
      if (!label) return null;
      // When sanitizing changed it, give the agent the exact key too, JSON-escaped
      // so it stays on one line and can't open a new entity line.
      const exact = label === key ? '' : ` key=${JSON.stringify(key)}`;
      return `- merchant "${label}"${exact} (match merchant_name or description)`;
    }
    case 'goal': {
      const g = getGoalById(db, m.id!);
      if (!g) return null;
      const target = g.target_amount != null ? `, target ${formatMoney(g.target_amount)}` : '';
      return `- goal id=${g.id} "${q(g.title)}" (${g.goal_type}, ${g.status}${target})`;
    }
    case 'entity': {
      const e = getEntityById(db, m.id!);
      if (!e) return null;
      return `- entity id=${e.id} slug=${e.slug} "${q(e.name)}"`;
    }
  }
}

/**
 * Remove a leading context block (header … blank line) from a persisted query,
 * leaving the user's words — for session titles and summary fallbacks.
 */
export function stripMentionContextBlock(text: string): string {
  if (!text.startsWith(CONTEXT_BLOCK_HEADER)) return text;
  const end = text.indexOf('\n\n');
  return end === -1 ? '' : text.slice(end + 2);
}

/**
 * Build the context block for validated mentions. Unresolvable mentions are
 * dropped; returns '' when nothing resolves. The block ends with a blank line.
 */
export function resolveMentionContext(db: Database, mentions: MentionRef[]): string {
  const lines: string[] = [];
  for (const m of mentions.slice(0, MAX_MENTIONS)) {
    let line: string | null = null;
    try {
      line = resolveOne(db, m);
    } catch {
      line = null; // missing table on an old profile, etc. — drop, never fail the chat
    }
    if (line && !lines.includes(line)) lines.push(line);
  }
  if (lines.length === 0) return '';
  return `${CONTEXT_BLOCK_HEADER}\n${lines.join('\n')}\n\n`;
}
