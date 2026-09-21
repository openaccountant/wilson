import { useState, useMemo } from 'react';
import { useApi } from '@/hooks/useApi';
import { useSemanticSearch } from '@/hooks/useSemanticSearch';
import { useAppState } from '@/state';
import { api } from '@/api';
import { formatAmount, formatDate } from '@/format';
import { ImportStatementDialog, type ImportResponse } from '@/components/ImportStatementDialog';
import type { Transaction, Entity } from '@/types';

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

  async function handleChange(value: string) {
    const newEntityId = value === '' ? null : Number(value);
    setSaving(true);
    try {
      await api(`/api/transactions/${txId}`, {
        method: 'PATCH',
        body: JSON.stringify({ entity_id: newEntityId }),
      });
      onUpdate(txId, newEntityId);
    } catch {
      // silent
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
}: {
  tx: Transaction;
  entities: Entity[];
  onUpdate: (txId: number, entityId: number | null) => void;
  /** Cosine similarity in [-1, 1] — present only on semantic matches. */
  score?: number;
}) {
  return (
    <tr className="border-b border-border last:border-b-0 hover:bg-surface transition-colors">
      <td className="px-4 py-3 text-text-secondary font-mono text-xs whitespace-nowrap">
        {formatDate(tx.date)}
      </td>
      <td className="px-4 py-3 text-text">
        <div className="flex items-center gap-2">
          <span className="truncate max-w-[300px]">
            {tx.merchant_name ?? tx.description}
          </span>
          {tx.pending && (
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

export function TransactionsTab() {
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [importOpen, setImportOpen] = useState(false);
  const [seedFile, setSeedFile] = useState<File | null>(null);
  const [banner, setBanner] = useState('');
  const [zoneDragOver, setZoneDragOver] = useState(false);
  const { dateRange, setDateRange, accountId, category: globalCategory, entityId } = useAppState();

  const apiPath = useMemo(() => {
    const parts = [`start=${dateRange.startDate}`, `end=${dateRange.endDate}`, 'limit=500'];
    if (accountId != null) parts.push(`accountId=${accountId}`);
    if (globalCategory) parts.push(`category=${encodeURIComponent(globalCategory)}`);
    if (entityId != null) parts.push(`entityId=${entityId}`);
    return `/api/transactions?${parts.join('&')}`;
  }, [dateRange, accountId, globalCategory, entityId]);

  const { data, loading, error, refetch } = useApi<Transaction[]>(apiPath, [apiPath]);
  const { data: entitiesData } = useApi<Entity[]>('/api/entities');
  const entities = useMemo(() => entitiesData ?? [], [entitiesData]);

  const categories = useMemo(() => {
    if (!data) return [];
    const set = new Set<string>();
    for (const tx of data) {
      if (tx.category) set.add(tx.category);
    }
    return Array.from(set).sort();
  }, [data]);

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

        <div className="flex gap-3">
          <input
            type="text"
            placeholder="Search by merchant or description..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="flex-1 bg-surface-raised border border-border rounded-md px-3 py-2 text-sm text-text placeholder:text-text-muted focus:outline-none focus:border-green"
          />
          <select
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
            className="bg-surface-raised border border-border rounded-md px-3 py-2 text-sm text-text focus:outline-none focus:border-green"
          >
            <option value="">All Categories</option>
            {categories.map((cat) => (
              <option key={cat} value={cat}>
                {cat}
              </option>
            ))}
          </select>
        </div>

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
                  <TxRow key={tx.id} tx={tx} entities={entities} onUpdate={handleEntityUpdate} />
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