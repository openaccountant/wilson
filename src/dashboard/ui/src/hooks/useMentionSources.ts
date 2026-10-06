import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/api';
import { money as money2, moneyWhole } from '@/format';
import type {
  Account,
  BudgetLimitRow,
  CategoryListItem,
  Entity,
  Goal,
  MentionType,
  MerchantListItem,
  SkillListItem,
} from '@/types';
import { accountMentionLabels, type Candidate } from '@/lib/typeahead';

/**
 * Candidate lists for the chat composer's "/" and "@" menus.
 *
 * Loaded lazily (first composer focus), cached at module level for 60 s so
 * re-mounting the Chat tab is instant, and invalidated after /profile switch.
 * Every source degrades independently: an endpoint that 404s (older server)
 * or is unavailable offline (the mirror doesn't serve these GETs) yields []
 * and its group simply doesn't show.
 */

export interface MentionSources {
  accounts: Account[];
  categories: CategoryListItem[];
  budgetLimits: BudgetLimitRow[];
  goals: Goal[];
  entities: Entity[];
  skills: SkillListItem[];
  profiles: string[];
  activeProfile: string | null;
}

const EMPTY: MentionSources = {
  accounts: [],
  categories: [],
  budgetLimits: [],
  goals: [],
  entities: [],
  skills: [],
  profiles: [],
  activeProfile: null,
};

const TTL_MS = 60_000;

let cache: { at: number; data: MentionSources } | null = null;
let inflight: Promise<MentionSources> | null = null;
const merchantCache = new Map<string, { at: number; rows: MerchantListItem[] }>();

async function safe<T>(path: string, fallback: T): Promise<T> {
  try {
    return await api<T>(path);
  } catch {
    return fallback;
  }
}

function loadSources(): Promise<MentionSources> {
  if (cache && Date.now() - cache.at < TTL_MS) return Promise.resolve(cache.data);
  inflight ??= (async () => {
    const [accounts, categories, budgetLimits, goals, entities, skills, profiles] = await Promise.all([
      safe<Account[]>('/api/accounts', []),
      safe<CategoryListItem[]>('/api/categories', []),
      safe<BudgetLimitRow[]>('/api/budgets/limits', []),
      safe<Goal[]>('/api/goals', []),
      safe<Entity[]>('/api/entities', []),
      safe<SkillListItem[]>('/api/skills', []),
      safe<{ profiles: string[]; active: string } | null>('/api/profiles', null),
    ]);
    const data: MentionSources = {
      accounts: Array.isArray(accounts) ? accounts.filter((a) => a.is_active) : [],
      categories: Array.isArray(categories) ? categories : [],
      budgetLimits: Array.isArray(budgetLimits) ? budgetLimits : [],
      goals: Array.isArray(goals) ? goals : [],
      entities: Array.isArray(entities) ? entities : [],
      skills: Array.isArray(skills) ? skills : [],
      profiles: profiles?.profiles ?? [],
      activeProfile: profiles?.active ?? null,
    };
    cache = { at: Date.now(), data };
    return data;
  })().finally(() => {
    inflight = null;
  });
  return inflight;
}

/** Drop every cached list (e.g. after a profile switch). */
export function invalidateMentionSources(): void {
  cache = null;
  merchantCache.clear();
}

export function useMentionSources(): {
  sources: MentionSources;
  loaded: boolean;
  ensureLoaded: () => void;
} {
  const [sources, setSources] = useState<MentionSources>(cache?.data ?? EMPTY);
  const [loaded, setLoaded] = useState(cache !== null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const ensureLoaded = useCallback(() => {
    loadSources().then((data) => {
      if (!mounted.current) return;
      setSources(data);
      setLoaded(true);
    });
  }, []);

  return { sources, loaded, ensureLoaded };
}

/**
 * Debounced (150 ms) merchant search for "@" queries of 2+ chars. A failing
 * endpoint (404 on an older server, offline) just yields no merchant group.
 */
export function useMerchantSearch(query: string | null): MerchantListItem[] {
  const q = query?.trim() ?? '';
  const [rows, setRows] = useState<MerchantListItem[]>([]);

  useEffect(() => {
    if (q.length < 2) {
      setRows([]);
      return;
    }
    const key = q.toLowerCase();
    const hit = merchantCache.get(key);
    if (hit && Date.now() - hit.at < TTL_MS) {
      setRows(hit.rows);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      safe<MerchantListItem[]>(`/api/merchants?q=${encodeURIComponent(q)}&limit=20`, []).then((r) => {
        const list = Array.isArray(r) ? r.filter((m) => m && typeof m.label === 'string' && m.label.trim()) : [];
        merchantCache.set(key, { at: Date.now(), rows: list });
        if (!cancelled) setRows(list);
      });
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [q]);

  return rows;
}

// ── Candidate building (no React) ──────────────────────────────────────────

export type BadgeTone = 'green' | 'blue' | 'yellow' | 'dim' | 'entity';

export interface MentionCandidate extends Candidate {
  mention: { type: MentionType; id?: number; key?: string; label: string };
  detail?: string;
  badge: { text: string; tone: BadgeTone; color?: string };
}

export const MENTION_GROUP_ORDER = ['Accounts', 'Categories', 'Merchants', 'Goals', 'Entities'];

/** Empty "@": recents, then 5 accounts and 5 categories. */
export const MENTION_EMPTY_LIMITS: Record<string, number> = {
  Accounts: 5,
  Categories: 5,
  Merchants: 0,
  Goals: 0,
  Entities: 0,
};

function money(n: number): string {
  return Number.isInteger(n) ? moneyWhole(n) : money2(n);
}

export function buildMentionCandidates(s: MentionSources, merchants: MerchantListItem[]): MentionCandidate[] {
  const out: MentionCandidate[] = [];

  const labels = accountMentionLabels(s.accounts);
  for (const a of s.accounts) {
    const label = labels.get(a.id) ?? a.name;
    const inst = [a.institution, a.account_number_last4 ? `••${a.account_number_last4}` : null].filter(Boolean).join(' ');
    out.push({
      id: `account:${a.id}`,
      group: 'Accounts',
      label,
      keywords: [a.name, a.institution ?? '', a.account_number_last4 ?? '', a.account_subtype].filter(Boolean),
      detail: [inst, a.account_subtype].filter(Boolean).join(' · '),
      badge: { text: 'ACCT', tone: 'blue' },
      mention: { type: 'account', id: a.id, label },
    });
  }

  const limitByCat = new Map<string, number>();
  for (const b of s.budgetLimits) limitByCat.set(b.category.toLowerCase(), b.monthly_limit);
  for (const c of s.categories) {
    const limit = limitByCat.get(c.name.toLowerCase()) ?? limitByCat.get(c.slug.toLowerCase());
    out.push({
      id: `category:${c.id}`,
      group: 'Categories',
      label: c.name,
      keywords: [c.slug],
      detail: limit != null ? `budget ${money(limit)}/mo` : undefined,
      badge: { text: 'CAT', tone: 'green' },
      mention: { type: 'category', id: c.id, label: c.name },
    });
  }

  for (const m of merchants) {
    out.push({
      id: `merchant:${m.label}`,
      group: 'Merchants',
      label: m.label,
      weight: m.n,
      detail: `${m.n} txn${m.n === 1 ? '' : 's'}`,
      badge: { text: 'MERCH', tone: 'yellow' },
      mention: { type: 'merchant', key: m.label, label: m.label },
    });
  }

  for (const g of s.goals) {
    out.push({
      id: `goal:${g.id}`,
      group: 'Goals',
      label: g.title,
      keywords: g.category ? [g.category] : [],
      detail: g.target_amount != null ? `target ${money(g.target_amount)}` : g.goal_type,
      badge: { text: 'GOAL', tone: 'dim' },
      mention: { type: 'goal', id: g.id, label: g.title },
    });
  }

  // A single (default) entity is noise — only offer entities when there's a choice.
  if (s.entities.length > 1) {
    for (const e of s.entities) {
      out.push({
        id: `entity:${e.id}`,
        group: 'Entities',
        label: e.name,
        keywords: [e.slug],
        detail: e.description ?? undefined,
        badge: { text: 'ENT', tone: 'entity', color: e.color },
        mention: { type: 'entity', id: e.id, label: e.name },
      });
    }
  }

  return out;
}

/** Every label the composer could have produced — used to chip tokens in history. */
export function knownMentionLabels(s: MentionSources): Set<string> {
  const set = new Set<string>();
  for (const l of accountMentionLabels(s.accounts).values()) set.add(l);
  for (const c of s.categories) set.add(c.name);
  for (const g of s.goals) set.add(g.title);
  for (const e of s.entities) set.add(e.name);
  return set;
}
