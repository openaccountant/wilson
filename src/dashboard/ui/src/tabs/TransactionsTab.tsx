import { useState, useMemo, useEffect, useRef } from 'react';
import { useApi } from '@/hooks/useApi';
import { useSemanticSearch } from '@/hooks/useSemanticSearch';
import { useMirrorStatus } from '@/hooks/useMirrorSync';
import { useAppState } from '@/state';
import { useUrlState } from '@/hooks/useUrlState';
import { api } from '@/api';
import { formatAmount, formatDate } from '@/format';
import { ImportStatementDialog, type ImportResponse } from '@/components/ImportStatementDialog';
import { classifyWriteError, type WriteFailureKind } from '@/store/offline-writes';
import { useDeclarativeTool } from '@/agent/useDeclarativeTool';
import { useWebMcpPageTools } from '@/agent/useWebMcpPageTools';
import { usePageContext } from '@/agent/WebMcpProvider';
import { dateOutsideRange, monthBoundsOf, pollUntil } from '@webmcp-page-tools';
import { armPageGuard, scrollForAgent } from '@/agent/agentGuard';
import { buildCategoryOptions } from '@declarative-submit';
import type { Transaction, Entity, CategoryRow } from '@/types';

/** Confidence at or above which the categorize tool auto-assigns (src/tools/categorize). */
const CONFIDENCE_REVIEW_THRESHOLD = 0.7;

function ConfidenceBadge({ tx }: { tx: Transaction }) {
  if (tx.user_verified) {
    return (
      <span
        title="Verified by you"
        className="inline-block text-[10px] px-1.5 py-0.5 rounded border border-green/40 bg-green/10 text-green"
      >
        verified
      </span>
    );
  }
  if (tx.category_confidence == null) return null;
  const low = tx.category_confidence < CONFIDENCE_REVIEW_THRESHOLD;
  return (
    <span
      title={
        low
          ? 'Low model confidence \u2014 worth reviewing'
          : 'Model confidence'
      }
      className={`inline-block text-[10px] px-1.5 py-0.5 rounded border font-mono ${
        low
          ? 'border-yellow/40 bg-yellow/10 text-yellow'
          : 'border-border bg-border-muted/60 text-text-muted'
      }`}
    >
      {Math.round(tx.category_confidence * 100)}%
    </span>
  );
}

function EntityCell({
  txId,
  entityId,
  entities,
  onUpdate,
}: {
  txId: number;
  entityId: number | null;
  entities: Entity[];
  onUpdate: (txId: number, entityId: number | null) => void;
}) {
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<WriteFailureKind | null>(null);

  async function handleChange(value: string) {
    const newEntityId = value === '' ? null : Number(value);
    setSaving(true);
    setSaveError(null);
    try {
      await api(`/api/transactions/${txId}`, {
        method: 'PATCH',
        body: JSON.stringify({ entity_id: newEntityId }),
      });
      onUpdate(txId, newEntityId);
    } catch (err) {
      // Offline (or otherwise failed) assignments surface an explicit state
      // instead of failing silently; the controlled select self-reverts because
      // onUpdate only fires on success.
      setSaveError(classifyWriteError(err));
    } finally {
      setSaving(false);
    }
  }

  if (entities.length <= 1) {
    const entity = entities.find((e) => e.id === entityId);
    return (
      <span className="text-text-muted text-xs">{entity?.name ?? '--'}</span>
    );
  }

  return (
    <div className="flex flex-col gap-0.5">
      <select
        value={entityId ?? ''}
        onChange={(e) => handleChange(e.target.value)}
        disabled={saving}
        className="bg-transparent border border-transparent hover:border-border rounded px-1 py-0.5 text-xs text-text-secondary cursor-pointer focus:outline-none focus:border-green disabled:opacity-50 w-full max-w-[120px]"
      >
        <option value="">--</option>
        {entities.map((e) => (
          <option key={e.id} value={e.id}>
            {e.name}
          </option>
        ))}
      </select>
      {saveError === 'requires-connection' && (
        <span className="text-[10px] leading-tight text-amber-500">
          Requires connection — assignment not saved
        </span>
      )}
      {saveError === 'failed' && (
        <span className="text-[10px] leading-tight text-red">Save failed</span>
      )}
    </div>
  );
}

function TxTableHead({ entities }: { entities: Entity[] }) {
  return (
    <thead className="sticky top-0 bg-surface-raised z-10">
      <tr className="border-b border-border text-text-secondary text-xs uppercase tracking-wide">
        <th className="text-left px-4 py-3 font-medium">Date</th>
        <th className="text-left px-4 py-3 font-medium">Description</th>
        <th className="text-right px-4 py-3 font-medium">Amount</th>
        <th className="text-left px-4 py-3 font-medium">Category</th>
        <th className="text-left px-4 py-3 font-medium">Account</th>
        {entities.length > 1 && (
          <th className="text-left px-4 py-3 font-medium">Entity</th>
        )}
      </tr>
    </thead>
  );
}

function TxRow({
  tx,
  entities,
  onUpdate,
  score,
  highlighted,
}: {
  tx: Transaction;
  entities: Entity[];
  onUpdate: (txId: number, entityId: number | null) => void;
  /** Cosine similarity in [-1, 1] — present only on semantic matches. */
  score?: number;
  /** The row a drill-down 'Open in Transactions' link pointed at (URL `txn`), or one an agent asked to show (`open_transaction`). */
  highlighted?: boolean;
}) {
  return (
    <tr
      data-txn-id={tx.id}
      data-tx-id={tx.id}
      aria-current={highlighted ? 'true' : undefined}
      className={`border-b border-border last:border-b-0 hover:bg-surface transition-colors ${
        highlighted ? 'bg-green/10 outline outline-1 outline-green/40' : ''
      }`}
    >
      <td className="px-4 py-3 text-text-secondary font-mono text-xs whitespace-nowrap">
        {formatDate(tx.date)}
      </td>
      <td className="px-4 py-3 text-text">
        <div className="flex items-center gap-2">
          <span className="truncate max-w-[300px]">
            {tx.merchant_name ?? tx.description}
          </span>
          {/* SQLite hands back 0/1, not a boolean — `0 && …` would render a literal "0". */}
          {!!tx.pending && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-border text-text-muted uppercase tracking-wider">
              pending
            </span>
          )}
          {score !== undefined && (
            <span
              className="text-[10px] px-1.5 py-0.5 rounded bg-border text-green font-mono whitespace-nowrap"
              title="Semantic similarity"
            >
              {Math.round(score * 100)}%
            </span>
          )}
        </div>
        {tx.merchant_name && tx.description !== tx.merchant_name && (
          <div className="text-xs text-text-muted truncate max-w-[300px]">
            {tx.description}
          </div>
        )}
      </td>
      <td
        className={`px-4 py-3 text-right font-mono whitespace-nowrap ${
          tx.amount < 0 ? 'text-red' : 'text-green'
        }`}
      >
        {formatAmount(tx.amount)}
      </td>
      <td className="px-4 py-3 text-text-secondary text-xs">
        {tx.category_detailed ?? tx.category ? (
          <span className="inline-flex items-center gap-1.5">
            {tx.category_detailed ?? tx.category}
            <ConfidenceBadge tx={tx} />
          </span>
        ) : (
          <span className="text-text-muted">Uncategorized</span>
        )}
      </td>
      <td className="px-4 py-3 text-text-secondary text-xs">
        {tx.account_name ?? <span className="text-text-muted">--</span>}
      </td>
      {entities.length > 1 && (
        <td className="px-4 py-3">
          <EntityCell
            txId={tx.id}
            entityId={tx.entity_id}
            entities={entities}
            onUpdate={onUpdate}
          />
        </td>
      )}
    </tr>
  );
}

/** The filter form's four boxes. While an agent's values are held they live here instead of in the real filters. */
interface FilterDraft {
  search: string;
  /** A category NAME ('' for all), as the tab-local filter holds it. */
  category: string;
  start: string;
  end: string;
}

export function TransactionsTab() {
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [importOpen, setImportOpen] = useState(false);
  const [seedFile, setSeedFile] = useState<File | null>(null);
  const [banner, setBanner] = useState('');
  const [zoneDragOver, setZoneDragOver] = useState(false);
  const mirror = useMirrorStatus();
  const { dateRange, setDateRange, accountId, category: globalCategory, entityId } = useAppState();
  // Drill-down links ('Open in Transactions') carry the exact merchant key and
  // optionally a transaction id; a plain tab switch drops both.
  const { state: url, navigate } = useUrlState();
  const merchantExact = url.merchant;
  const highlightId = url.txn && /^\d+$/.test(url.txn) ? Number(url.txn) : null;
  const clearMerchant = () => navigate((s) => ({ ...s, merchant: null, txn: null }), { mode: 'replace' });

  const apiPath = useMemo(() => {
    const parts = [`start=${dateRange.startDate}`, `end=${dateRange.endDate}`, 'limit=500'];
    if (accountId != null) parts.push(`accountId=${accountId}`);
    if (globalCategory) parts.push(`category=${encodeURIComponent(globalCategory)}`);
    if (entityId != null) parts.push(`entityId=${entityId}`);
    // Exact label match — never the fuzzy `merchant` (description LIKE) param.
    if (merchantExact) parts.push(`merchantExact=${encodeURIComponent(merchantExact)}`);
    return `/api/transactions?${parts.join('&')}`;
  }, [dateRange, accountId, globalCategory, entityId, merchantExact]);

  const { data, loading, error, refetch } = useApi<Transaction[]>(apiPath, [apiPath]);

  // Bring the linked transaction into view once its page has loaded.
  useEffect(() => {
    if (highlightId == null || !data) return;
    // The least scroll that shows it (never centred): the same helper every agent-driven scroll uses (T16).
    scrollForAgent(document.querySelector<HTMLElement>(`tr[data-txn-id="${highlightId}"]`));
  }, [highlightId, data]);
  const { data: entitiesData } = useApi<Entity[]>('/api/entities');
  const entities = useMemo(() => entitiesData ?? [], [entitiesData]);

  // Category rows (with ids) feed the filter's <select>: the agent-facing tool takes `category_id`, and option
  // labels go through the same safe-label rule as everything else an agent reads (threat T20).
  const { data: categoryRows } = useApi<CategoryRow[]>('/api/categories');
  const categoryOptions = useMemo(() => buildCategoryOptions(categoryRows ?? []), [categoryRows]);
  const categoryIdFor = (name: string): string => {
    const row = (categoryRows ?? []).find((c) => c.name === name);
    return row ? String(row.id) : '';
  };

  // The filter bar is a declarative form (`list_transactions`). Humans keep filtering live as they type; an
  // agent's submit is a server read, after which the page applies the same filters to its own state.
  //
  // An agent's values must not filter the list (or move the app-wide date range, which refetches) before the server
  // authorizes the call: under an Ask policy the card is still open while the agent has already filled the form. While
  // `effectsHeld` the boxes write into a DRAFT and the real filters stay the human's; the draft becomes the filters in
  // `afterServer` (authorized) and is dropped by `restore` (Reject, expiry, a refusal, the agent cancelling).
  const [draft, setDraft] = useState<FilterDraft | null>(null);
  const filterForm = useDeclarativeTool({
    tool: 'list_transactions',
    // Options are loaded before the form advertises itself, so Chrome derives the complete category enum.
    ready: categoryRows != null,
    snapshot: () => ({ search, category: categoryFilter, start: dateRange.startDate, end: dateRange.endDate }),
    restore: (snap) => {
      setDraft(null);
      const human = snap as FilterDraft | undefined;
      if (!human) return;
      // Under Allow the agent's values were applied live: put the human's back (only what differs).
      if (human.search !== search) setSearch(human.search);
      if (human.category !== categoryFilter) setCategoryFilter(human.category);
      if (human.start !== dateRange.startDate || human.end !== dateRange.endDate) setDateRange({ startDate: human.start, endDate: human.end });
    },
    afterServer: (args, server) => {
      setDraft(null);
      setSearch(typeof args.search === 'string' ? args.search : '');
      const picked = (categoryRows ?? []).find((c) => c.id === args.category_id);
      setCategoryFilter(picked ? picked.name : '');
      const start = typeof args.start === 'string' ? args.start : dateRange.startDate;
      const end = typeof args.end === 'string' ? args.end : dateRange.endDate;
      if (start !== dateRange.startDate || end !== dateRange.endDate) setDateRange({ startDate: start, endDate: end });
      return server;
    },
  });
  const humanFilters: FilterDraft = { search, category: categoryFilter, start: dateRange.startDate, end: dateRange.endDate };
  const shownFilters = draft ?? humanFilters;
  /**
   * A box changed: into the draft while an agent's values are held, else straight into the real filter. The hold is read
   * from `effectsHeldRef` at event time (set inside the `toolactivated` listener), never from render state, which lags
   * the event: the agent's first `input` events can land before the render that would show the hold. The draft is
   * updated functionally for the same reason, since several fields can change within one tick.
   */
  const editFilter = (patch: Partial<FilterDraft>, apply: () => void) => {
    if (filterForm.effectsHeldRef.current) setDraft((d) => ({ ...(d ?? humanFilters), ...patch }));
    else apply();
  };
  const filterCategoryOptions = filterForm.hold('categories', categoryOptions);

  // The category select lists every category (/api/categories), not just the ones in the loaded page, so a
  // filter whose category has no rows in the current range still shows as selected (the stale "All Categories"
  // display the page-derived list once had cannot happen) and the empty state explains the empty list.

  const filtered = useMemo(() => {
    if (!data) return [];
    return data.filter((tx) => {
      if (search) {
        const q = search.toLowerCase();
        const merchant = (tx.merchant_name ?? '').toLowerCase();
        const desc = tx.description.toLowerCase();
        if (!merchant.includes(q) && !desc.includes(q)) return false;
      }
      if (categoryFilter && tx.category !== categoryFilter) return false;
      return true;
    });
  }, [data, search, categoryFilter]);

  // ── Semantic fallback ─────────────────────────────────────────────────────
  // Strictly additive: only when the substring search over the loaded page
  // yields nothing (and the page itself has loaded with data) do we ask the
  // server for semantic matches. Any substring match instantly takes over.
  const query = search.trim();
  const semanticActive =
    query.length >= 2 && data != null && data.length > 0 && !loading && filtered.length === 0;

  const semanticPath = useMemo(() => {
    if (!semanticActive) return null;
    // Same filter params as apiPath, plus the query and the search's own limit.
    const parts = [`start=${dateRange.startDate}`, `end=${dateRange.endDate}`];
    if (accountId != null) parts.push(`accountId=${accountId}`);
    if (globalCategory) parts.push(`category=${encodeURIComponent(globalCategory)}`);
    if (entityId != null) parts.push(`entityId=${entityId}`);
    parts.push(`q=${encodeURIComponent(query)}`, 'limit=25');
    return `/api/transactions/search?${parts.join('&')}`;
  }, [semanticActive, dateRange, accountId, globalCategory, entityId, query]);

  const {
    data: semanticData,
    loading: semanticLoading,
    error: semanticError,
    refetch: semanticRefetch,
  } = useSemanticSearch(semanticPath, [semanticPath]);

  // The tab-local category filter composes over semantic results too.
  const semanticResults = useMemo(() => {
    if (!semanticData) return [];
    return semanticData.results.filter((tx) => {
      if (categoryFilter && tx.category !== categoryFilter) return false;
      return true;
    });
  }, [semanticData, categoryFilter]);

  // ── Agent journey: open one transaction (`open_transaction`) ──────────────
  // The bridge registers the tool only while this tab shows; the server has already authorized the call and read the
  // row (`pageData`). The handler makes the row visible, then says whether it really is on screen.
  const [highlightedId, setHighlightedId] = useState<number | null>(null);
  const shownIds = useMemo(() => new Set((semanticActive ? semanticResults : filtered).map((t) => t.id)), [semanticActive, semanticResults, filtered]);
  const latest = useRef({ shownIds, dateRange, setDateRange, search, categoryFilter });
  latest.current = { shownIds, dateRange, setDateRange, search, categoryFilter };

  useWebMcpPageTools('transactions', {
    open_transaction: async (args, { signal, pageData }) => {
      const id = args.id as number;
      const row = (pageData ?? { id }) as Record<string, unknown>;
      const { shownIds: shown, dateRange: range, setDateRange: moveRange, search: typed, categoryFilter: chosen } = latest.current;
      let filtersCleared = false;
      if (!shown.has(id)) {
        // Clearing filters or moving the range re-lays out the list under the pointer: guard first (T16).
        armPageGuard();
        // Not in view: drop this tab's own filters (and say so), and move to the row's month only when the row's date
        // is outside the loaded range. A row inside the range is hidden by a filter, not by the range: leave the range.
        filtersCleared = typed !== '' || chosen !== '';
        setSearch('');
        setCategoryFilter('');
        const month = monthBoundsOf(row.date);
        if (month && dateOutsideRange(row.date, range)) moveRange(month);
      }
      setHighlightedId(id);
      const selector = `[data-tx-id="${id}"]`;
      const onScreen = await pollUntil(() => document.querySelector(selector) !== null, signal, { timeoutMs: 2500 });
      if (onScreen) {
        // Not centred, and not at all when the row is already fully visible. Any agent-driven move pauses the page's human actions for a moment (T16).
        armPageGuard();
        scrollForAgent(document.querySelector(selector));
      }
      return onScreen
        ? { ...row, highlighted: true, ...(filtersCleared ? { filtersCleared: true } : {}) }
        : { ...row, highlighted: false, ...(filtersCleared ? { filtersCleared: true } : {}), viewNote: 'The row is not in this view. A header filter (account, category, entity) may be hiding it.' };
    },
  });

  // The highlight is a cue, not a state: it fades after a while.
  useEffect(() => {
    if (highlightedId === null) return;
    const timer = setTimeout(() => setHighlightedId(null), 10_000);
    return () => clearTimeout(timer);
  }, [highlightedId]);

  usePageContext('transactions', {
    filters: { search, ...(categoryFilter ? { category: categoryFilter } : {}) },
    selection: { transactionId: highlightedId },
    visibleRows: shownIds.size,
  });

  function handleEntityUpdate(txId: number, newEntityId: number | null) {
    // Optimistically update local data
    if (data) {
      const tx = data.find((t) => t.id === txId);
      if (tx) tx.entity_id = newEntityId;
      refetch();
    }
    // Semantic rows may not be on the loaded page — refresh them too so the
    // entity cell reflects the update.
    semanticRefetch();
  }

  function openImporter() {
    setSeedFile(null);
    setImportOpen(true);
  }

  function dropStatement(files: FileList | null) {
    const file = files?.[0];
    if (!file) return;
    // One file at a time; extension/format validation (and the error path)
    // lives in the dialog, so an unsupported file shows its inline error.
    setSeedFile(file);
    setImportOpen(true);
  }

  function handleImported(result: ImportResponse) {
    setImportOpen(false);
    refetch();
    // Switch the visible window to the imported dates when the current range
    // doesn't cover them (ISO strings compare lexicographically), so fresh rows
    // aren't hidden under the default current-month filter.
    if (
      result.transactionsImported > 0 &&
      result.dateRange &&
      (dateRange.startDate > result.dateRange.start || dateRange.endDate < result.dateRange.end)
    ) {
      setDateRange({ startDate: result.dateRange.start, endDate: result.dateRange.end });
    }
    setBanner(result.message);
  }

  const coveragePartial = semanticData != null && semanticData.indexed < semanticData.total;

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Fixed header + filters */}
      <div className="shrink-0 p-6 pb-0 space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h2 className="text-lg font-semibold text-text">Transactions</h2>
            {mirror.available && mirror.seeded && !mirror.online && (
              <span
                data-testid="offline-pill"
                className="text-[10px] px-2 py-0.5 rounded-full bg-amber-400/10 text-amber-500 uppercase tracking-wide"
              >
                Offline — showing synced data
              </span>
            )}
            {data && (
              <span className="text-xs text-text-muted font-mono">
                {semanticActive
                  ? semanticLoading
                    ? 'searching…'
                    : semanticError
                      ? 'semantic search failed'
                      : `${semanticResults.length} of ${semanticData?.results.length ?? 0} semantic matches`
                  : `${filtered.length} of ${data.length} transactions`}
              </span>
            )}
          </div>
          <button
            onClick={openImporter}
            className="bg-green-700 hover:bg-green-600 text-white text-sm font-medium px-3 py-2 rounded-lg transition-colors cursor-pointer border-none"
          >
            Import statement
          </button>
        </div>

        <form key={filterForm.formKey} className="flex gap-3" aria-label="Filter transactions" {...filterForm.formProps}>
          <input
            type="text"
            name="search"
            placeholder="Search by merchant or description..."
            value={shownFilters.search}
            onChange={(e) => editFilter({ search: e.target.value }, () => setSearch(e.target.value))}
            className="flex-1 bg-surface-raised border border-border rounded-md px-3 py-2 text-sm text-text placeholder:text-text-muted focus:outline-none focus:border-green"
            {...filterForm.field('search')}
          />
          <select
            name="category_id"
            value={categoryIdFor(shownFilters.category)}
            onChange={(e) => {
              const name = categoryRows?.find((c) => String(c.id) === e.target.value)?.name ?? '';
              editFilter({ category: name }, () => setCategoryFilter(name));
            }}
            className="bg-surface-raised border border-border rounded-md px-3 py-2 text-sm text-text focus:outline-none focus:border-green"
            {...filterForm.field('category_id')}
          >
            <option value="">All Categories</option>
            {filterCategoryOptions.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
          <input
            type="date"
            name="start"
            aria-label="From date"
            value={shownFilters.start}
            onChange={(e) => e.target.value && editFilter({ start: e.target.value }, () => setDateRange({ ...dateRange, startDate: e.target.value }))}
            className="bg-surface-raised border border-border rounded-md px-2 py-2 text-sm text-text focus:outline-none focus:border-green"
            {...filterForm.field('start')}
          />
          <input
            type="date"
            name="end"
            aria-label="To date"
            value={shownFilters.end}
            onChange={(e) => e.target.value && editFilter({ end: e.target.value }, () => setDateRange({ ...dateRange, endDate: e.target.value }))}
            className="bg-surface-raised border border-border rounded-md px-2 py-2 text-sm text-text focus:outline-none focus:border-green"
            {...filterForm.field('end')}
          />
          <button
            type="submit"
            className="bg-surface-raised hover:bg-border-muted text-text-secondary border border-border text-sm font-medium px-3 py-2 rounded-md transition-colors cursor-pointer whitespace-nowrap"
          >
            Apply
          </button>
        </form>

        {merchantExact && (
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center gap-1.5 text-xs px-2 py-1 rounded-full border border-green/40 bg-green/10 text-green max-w-full">
              <span className="truncate">Merchant: {merchantExact}</span>
              <button
                type="button"
                onClick={clearMerchant}
                aria-label={`Clear merchant filter ${merchantExact}`}
                className="bg-transparent border-none p-0 text-green hover:text-text cursor-pointer leading-none"
              >
                &times;
              </button>
            </span>
          </div>
        )}

        {banner && (
          <div className="flex items-center justify-between border border-green-700/50 bg-green-900/30 text-text rounded-md px-3 py-2 text-sm">
            <span className="break-words">{banner}</span>
            <button
              onClick={() => setBanner('')}
              className="text-text-muted hover:text-text bg-transparent border-none text-base cursor-pointer ml-3 shrink-0"
              aria-label="Dismiss"
            >
              &times;
            </button>
          </div>
        )}

        {coveragePartial && (
          <p className="text-xs text-text-muted">
            Semantic index covers {semanticData!.indexed} of {semanticData!.total} transactions — run{' '}
            <code className="font-mono bg-surface-raised border border-border rounded px-1 py-0.5">
              wilson --index
            </code>{' '}
            to index the rest.
          </p>
        )}
      </div>

      {/* Scrollable table area */}
      <div className="flex-1 overflow-y-auto px-6 py-4 min-h-0">
        {loading && (
          <div className="bg-surface-raised border border-border rounded-lg p-4">
            <div className="h-[300px] animate-pulse bg-border-muted rounded" />
          </div>
        )}

        {error && (
          <div className="bg-surface-raised border border-border rounded-lg p-4 text-red text-sm">
            Failed to load transactions: {error}
          </div>
        )}

        {!loading && !error && semanticActive && (
          semanticLoading ? (
            <div className="bg-surface-raised border border-border rounded-lg p-4">
              <p className="text-sm text-text-muted animate-pulse">Searching semantically…</p>
            </div>
          ) : semanticError ? (
            <div className="bg-surface-raised border border-border rounded-lg p-8 text-center space-y-2">
              <p className="text-sm text-text-muted">No transactions match your filters.</p>
              <p className="text-xs text-text-muted">Semantic search failed: {semanticError}</p>
            </div>
          ) : semanticResults.length === 0 ? (
            <div className="bg-surface-raised border border-border rounded-lg p-8 text-center">
              <p className="text-sm text-text-muted">No semantic matches for “{query}”.</p>
            </div>
          ) : (
            <div>
              <div className="flex items-center gap-2 mb-2">
                <h3 className="text-sm text-text-secondary">
                  Semantic matches for “{query}”
                </h3>
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-border text-text-muted uppercase tracking-wider">
                  semantic
                </span>
              </div>
              <div className="bg-surface-raised border border-border rounded-lg overflow-hidden">
                <table className="w-full text-sm">
                  <TxTableHead entities={entities} />
                  <tbody>
                    {semanticResults.map((tx) => (
                      <TxRow
                        key={tx.id}
                        tx={tx}
                        entities={entities}
                        onUpdate={handleEntityUpdate}
                        score={tx.score}
                        highlighted={tx.id === highlightedId}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )
        )}

        {!loading && !error && !semanticActive && filtered.length === 0 && (
          data && data.length > 0 ? (
            <div className="bg-surface-raised border border-border rounded-lg p-8 text-center">
              <p className="text-sm text-text-muted">No transactions match your filters.</p>
            </div>
          ) : (
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setZoneDragOver(true);
              }}
              onDragLeave={() => setZoneDragOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setZoneDragOver(false);
                dropStatement(e.dataTransfer.files);
              }}
              onClick={openImporter}
              className={`rounded-lg border-2 border-dashed p-10 text-center cursor-pointer transition-colors ${
                zoneDragOver ? 'border-green bg-green/10' : 'border-border bg-surface-raised hover:border-green'
              }`}
            >
              <div className="text-3xl mb-2">📥</div>
              <p className="text-sm text-text">Drop a bank statement here</p>
              <p className="text-xs text-text-muted mt-1">
                CSV, OFX, or QIF — or click to browse. Preview the parse before anything is imported.
              </p>
              <p className="text-xs text-text-muted mt-4">No transactions found.</p>
            </div>
          )
        )}

        {!loading && !error && !semanticActive && filtered.length > 0 && (
          <div className="bg-surface-raised border border-border rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <TxTableHead entities={entities} />
              <tbody>
                {filtered.map((tx) => (
                  <TxRow
                    key={tx.id}
                    tx={tx}
                    entities={entities}
                    onUpdate={handleEntityUpdate}
                    highlighted={tx.id === highlightId || tx.id === highlightedId}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <ImportStatementDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        seedFile={seedFile}
        onSeedConsumed={() => setSeedFile(null)}
        onImported={handleImported}
      />
    </div>
  );
}