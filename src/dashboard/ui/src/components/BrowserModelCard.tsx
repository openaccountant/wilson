import { useCallback, useEffect, useState } from 'react';
import { api } from '@/api';
import { useApi } from '@/hooks/useApi';
import type { InTabModelStatus } from '@/hybrid/standalone';
import {
  apiErrorText,
  benchRows,
  cachedRepos,
  canApplyUpdate,
  canUseValidated,
  formatBytes,
  hasCrossOriginStorage,
  hybridCapabilities,
  missingNote,
  modelSourceLabel,
  parseRepoInput,
  persistenceLine,
  shortSha,
  sortCacheGroups,
  updateLine,
  type BenchResultLike,
  type BrowserModelUpdate,
  type BrowserModelValidation,
  type BrowserModelsOverview,
  type CacheStatsLike,
  type HybridModelManagerLike,
} from '@/lib/browserModel';

/**
 * Settings > Models > Browser model (specs/model-manager.md M5 UI paragraph).
 *
 * Server writes (choose, reset, COS flag, apply update) are admin-only, the same gate as the Models panel. Cache,
 * benchmark and status come from the hybrid chunk on `window.WilsonHybridChat`; every method there is optional
 * (older chunks lack them) and the card says so instead of failing. The card never loads the chunk itself: a
 * second init() would replace the chat's client and drop a loaded model.
 */

interface Props {
  canWrite: boolean;
}

type HybridGlobal = HybridModelManagerLike & {
  getModelStatus?(): InTabModelStatus;
  onModelStatus?(listener: (status: InTabModelStatus) => void): () => void;
};

function readHybrid(): HybridGlobal | null {
  if (typeof window === 'undefined') return null;
  return (window.WilsonHybridChat as HybridGlobal | undefined) ?? null;
}

const btnPrimary =
  'bg-green text-black px-3 py-1 rounded text-xs font-medium cursor-pointer border-none disabled:opacity-50 disabled:cursor-not-allowed';
const btnSecondary =
  'text-xs text-green bg-transparent border border-border rounded px-3 py-1 cursor-pointer hover:border-green disabled:opacity-50 disabled:cursor-not-allowed';
const btnGhost = 'bg-transparent text-text-muted border border-border px-3 py-1 rounded text-xs cursor-pointer';
const btnDanger = 'px-3 py-1 rounded text-xs font-medium cursor-pointer border-none bg-red/20 text-red hover:bg-red/30 disabled:opacity-50';
const subhead = 'text-[10px] uppercase tracking-wide font-medium text-text-secondary';

function statusText(s: InTabModelStatus): string {
  switch (s.state) {
    case 'idle':
      return 'Not loaded in this tab';
    case 'loading':
      return `Loading: ${s.label}`;
    case 'ready':
      return 'Loaded in this tab';
    case 'failed':
      return `Failed to load${s.detail ? `: ${s.detail}` : ''}`;
  }
}

export function BrowserModelCard({ canWrite }: Props) {
  const { data: overview, loading, error: loadError, refetch } = useApi<BrowserModelsOverview>('/api/models/browser');
  const [hybrid, setHybrid] = useState<HybridGlobal | null>(() => readHybrid());
  const caps = hybridCapabilities(hybrid);
  const [modelStatus, setModelStatus] = useState<InTabModelStatus | null>(null);

  // Choosing
  const [catalogPick, setCatalogPick] = useState('');
  const [customInput, setCustomInput] = useState('');
  const [validation, setValidation] = useState<BrowserModelValidation | null>(null);
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [chooseError, setChooseError] = useState('');
  const [confirmReset, setConfirmReset] = useState(false);

  // Cache
  const [stats, setStats] = useState<CacheStatsLike | null>(null);
  const [statsError, setStatsError] = useState('');
  const [confirmClear, setConfirmClear] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);
  const [clearNote, setClearNote] = useState('');

  // COS
  const [cosSaving, setCosSaving] = useState(false);
  const [cosError, setCosError] = useState('');
  const cosInBrowser = typeof navigator !== 'undefined' && hasCrossOriginStorage(navigator);

  // Bench
  const [benchRunning, setBenchRunning] = useState(false);
  const [benchProgress, setBenchProgress] = useState('');
  const [benchError, setBenchError] = useState('');
  const [bench, setBench] = useState<BenchResultLike | null>(null);

  // Updates
  const [updates, setUpdates] = useState<BrowserModelUpdate[] | null>(null);
  const [checkingUpdates, setCheckingUpdates] = useState(false);
  const [updatesError, setUpdatesError] = useState('');
  const [confirmUpdate, setConfirmUpdate] = useState<string | null>(null);

  const current = overview?.current ?? null;

  useEffect(() => {
    if (!hybrid?.onModelStatus) return;
    return hybrid.onModelStatus((s) => setModelStatus(s));
  }, [hybrid]);

  const loadStats = useCallback(async () => {
    const h = readHybrid();
    setHybrid(h);
    if (!h?.cacheStats) {
      setStats(null);
      return;
    }
    try {
      setStatsError('');
      setStats(await h.cacheStats());
    } catch (err) {
      setStatsError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void loadStats();
  }, [loadStats]);

  // The last benchmark for whatever model is current.
  useEffect(() => {
    if (!current?.enabled || !hybrid?.lastBench) {
      setBench(null);
      return;
    }
    try {
      setBench(hybrid.lastBench(current.repo, current.revision, current.dtype));
    } catch {
      setBench(null);
    }
  }, [hybrid, current?.enabled, current?.repo, current?.revision, current?.dtype]);

  /** After any server write: refetch the overview and tell the chunk to re-read its config. */
  async function afterWrite() {
    refetch();
    try {
      await readHybrid()?.refreshConfig?.();
    } catch {
      // the next chat turn re-reads the config anyway
    }
    setUpdates(null);
    void loadStats();
  }

  async function saveModel(repo: string, revision?: string) {
    setSaving(true);
    setChooseError('');
    try {
      await api('/api/models/browser', { method: 'POST', body: JSON.stringify(revision ? { repo, revision } : { repo }) });
      setValidation(null);
      setCustomInput('');
      setCatalogPick('');
      await afterWrite();
    } catch (err) {
      setChooseError(apiErrorText(err));
    } finally {
      setSaving(false);
    }
  }

  async function handleCheck() {
    const parsed = parseRepoInput(customInput);
    setValidation(null);
    setChooseError('');
    if (!parsed) {
      setChooseError('Enter a Hugging Face model id like owner/name, or paste its huggingface.co link.');
      return;
    }
    setChecking(true);
    try {
      setValidation(
        await api<BrowserModelValidation>('/api/models/browser/validate', { method: 'POST', body: JSON.stringify(parsed) }),
      );
    } catch (err) {
      setChooseError(apiErrorText(err));
    } finally {
      setChecking(false);
    }
  }

  async function handleReset() {
    setConfirmReset(false);
    setSaving(true);
    setChooseError('');
    try {
      await api('/api/models/browser', { method: 'DELETE' });
      await afterWrite();
    } catch (err) {
      setChooseError(apiErrorText(err));
    } finally {
      setSaving(false);
    }
  }

  async function handleClear(repo: string) {
    setConfirmClear(null);
    const h = readHybrid();
    if (!h?.cacheClear) return;
    setClearing(true);
    setClearNote('');
    try {
      const res = await h.cacheClear(repo);
      setClearNote(res ? `Removed ${res.removed} file${res.removed === 1 ? '' : 's'} for ${repo}.` : 'The in-tab chat is not configured yet.');
    } catch (err) {
      setClearNote(`Could not clear ${repo}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setClearing(false);
      void loadStats();
    }
  }

  async function handleCos(next: boolean) {
    setCosSaving(true);
    setCosError('');
    try {
      await api('/api/models/browser/cache', { method: 'PUT', body: JSON.stringify({ crossOriginStorage: next }) });
      await afterWrite();
    } catch (err) {
      setCosError(apiErrorText(err));
    } finally {
      setCosSaving(false);
    }
  }

  async function handleBench() {
    const h = readHybrid();
    setHybrid(h);
    if (!h?.bench) return;
    setBenchRunning(true);
    setBenchError('');
    setBenchProgress('Starting…');
    try {
      const result = await h.bench((label) => setBenchProgress(label));
      if (result) setBench(result);
      else setBenchError('No browser model is configured.');
    } catch (err) {
      const e = err as { message?: unknown } | null;
      setBenchError(typeof e?.message === 'string' ? e.message : String(err));
    } finally {
      setBenchRunning(false);
      setBenchProgress('');
      void loadStats();
    }
  }

  async function handleCheckUpdates() {
    setCheckingUpdates(true);
    setUpdatesError('');
    try {
      const res = await api<{ updates: BrowserModelUpdate[] }>('/api/models/browser/updates');
      setUpdates(res.updates);
    } catch (err) {
      setUpdatesError(apiErrorText(err));
    } finally {
      setCheckingUpdates(false);
    }
  }

  async function handleApplyUpdate(u: BrowserModelUpdate) {
    setConfirmUpdate(null);
    if (!u.latest) return;
    await saveModel(u.repo, u.latest);
  }

  if (loading && !overview) {
    return (
      <div className="bg-surface border border-border rounded px-3 py-2">
        <div className="h-[80px] animate-pulse bg-border-muted rounded" />
      </div>
    );
  }

  if (!overview) {
    return (
      <div className="bg-surface border border-border rounded px-3 py-2">
        <div className="text-sm text-text">Browser model</div>
        <p className="text-xs text-amber-500 mt-1">Could not load the browser model settings{loadError ? ` — ${apiErrorText(loadError)}` : ''}.</p>
      </div>
    );
  }

  const source = modelSourceLabel(overview);
  const canUse = canUseValidated(validation, customInput);
  const pickedCatalog = overview.catalog.find((m) => m.repo === catalogPick) ?? null;
  const sortedGroups = stats ? sortCacheGroups(stats.groups, current) : [];
  const repos = cachedRepos(sortedGroups);
  const cacheNote = missingNote(caps, 'cache');
  const benchNote = missingNote(caps, 'bench');

  return (
    <div className="bg-surface border border-border rounded px-3 py-3 space-y-4" data-testid="browser-model-card">
      {/* ── Current ── */}
      <div>
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm text-text">Browser model</span>
          <span className="text-[10px] uppercase tracking-wide font-medium px-1.5 py-0.5 rounded bg-green/15 text-green">
            Runs on this device
          </span>
        </div>
        <p className="text-xs text-text-muted mt-1">
          The model the chat runs in this browser tab with WebGPU. Your questions and data never leave the device on this path.
        </p>
        {current?.enabled ? (
          <dl className="mt-2 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-0.5 text-xs">
            <dt className="text-text-muted">Model</dt>
            <dd className="text-text">{current.displayName}</dd>
            <dt className="text-text-muted">Repo</dt>
            <dd className="text-text font-mono break-all">{current.repo}</dd>
            <dt className="text-text-muted">Revision</dt>
            <dd className="text-text font-mono" title={current.revision ?? undefined}>
              {current.revision ? shortSha(current.revision) : 'main (not pinned)'}
            </dd>
            <dt className="text-text-muted">dtype</dt>
            <dd className="text-text font-mono">{current.dtype ?? 'resolved on load'}</dd>
            <dt className="text-text-muted">Download</dt>
            <dd className="text-text">{current.downloadSize}</dd>
            <dt className="text-text-muted">Source</dt>
            <dd className="text-text">{source}</dd>
            {modelStatus && (
              <>
                <dt className="text-text-muted">This tab</dt>
                <dd className="text-text">{statusText(modelStatus)}</dd>
              </>
            )}
          </dl>
        ) : (
          <p className="text-xs text-text-muted mt-2">No browser model is configured. The chat uses the server.</p>
        )}
      </div>

      {/* ── Choose ── */}
      {canWrite ? (
        <div className="space-y-2">
          <div className={subhead}>Choose a model</div>
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={catalogPick}
              onChange={(e) => setCatalogPick(e.target.value)}
              disabled={saving}
              aria-label="Catalog browser models"
              className="bg-surface border border-border rounded px-3 py-1.5 text-sm text-text flex-1 min-w-[200px] max-w-md disabled:opacity-50"
            >
              <option value="">Vetted WebGPU models…</option>
              {overview.catalog.map((m) => (
                <option key={m.id} value={m.repo}>
                  {m.displayName}
                  {m.downloadSize ? ` (${m.downloadSize})` : ''}
                  {m.repo === current?.repo ? ' — current' : ''}
                </option>
              ))}
            </select>
            <button
              onClick={() => pickedCatalog && saveModel(pickedCatalog.repo)}
              disabled={!pickedCatalog || saving || pickedCatalog.repo === current?.repo}
              className={btnPrimary}
            >
              {saving && pickedCatalog ? 'Saving…' : 'Use this model'}
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <input
              type="text"
              value={customInput}
              onChange={(e) => {
                setCustomInput(e.target.value);
                setChooseError('');
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && customInput.trim() && !checking) void handleCheck();
              }}
              placeholder="Use another Hugging Face model: owner/name or a huggingface.co link"
              aria-label="Hugging Face model id or link"
              className="bg-surface border border-border rounded px-2 py-1.5 text-sm text-text flex-1 min-w-[200px] max-w-md"
            />
            <button onClick={handleCheck} disabled={!customInput.trim() || checking || saving} className={btnSecondary}>
              {checking ? 'Checking…' : 'Check'}
            </button>
            <button
              onClick={() => validation && saveModel(validation.repo, validation.revision ?? undefined)}
              disabled={!canUse || saving}
              className={btnPrimary}
            >
              {saving && validation ? 'Saving…' : 'Use this model'}
            </button>
          </div>

          {validation && (
            <div className="border border-border rounded px-2 py-1.5 text-xs space-y-1" data-testid="browser-model-validation">
              <div className={validation.ok ? 'text-green' : 'text-red'}>
                {validation.ok ? `${validation.repo} can run in the browser.` : `${validation.repo || 'This model'} can't run in the browser.`}
              </div>
              {validation.errors.map((e) => (
                <div key={e} role="alert" className="text-red">
                  {e}
                </div>
              ))}
              {validation.warnings.map((w) => (
                <div key={w} className="text-amber-500">
                  {w}
                </div>
              ))}
              {(validation.revision || validation.dtype || validation.downloadSize || validation.license) && (
                <div className="text-text-muted">
                  {[
                    validation.revision ? `revision ${shortSha(validation.revision)}` : null,
                    validation.dtype ? `dtype ${validation.dtype}` : null,
                    validation.downloadSize ? `download ${validation.downloadSize}` : null,
                    `license ${validation.license ?? 'none declared'}`,
                    validation.modelType ? `architecture ${validation.modelType}` : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </div>
              )}
            </div>
          )}

          {chooseError && (
            <p role="alert" className="text-xs text-red">
              {chooseError}
            </p>
          )}

          {overview.saved && (
            <div className="flex flex-wrap items-center gap-2">
              {confirmReset ? (
                <>
                  <span className="text-xs text-text-muted">Go back to the provider default model?</span>
                  <button onClick={handleReset} disabled={saving} className={btnDanger}>
                    Reset
                  </button>
                  <button onClick={() => setConfirmReset(false)} className={btnGhost}>
                    Cancel
                  </button>
                </>
              ) : (
                <button onClick={() => setConfirmReset(true)} disabled={saving} className={btnGhost}>
                  Reset to default
                </button>
              )}
            </div>
          )}
          <p className="text-xs text-text-muted">
            Models are pinned to a Hub commit when chosen; nothing loads from <span className="font-mono">main</span> live.
          </p>
        </div>
      ) : (
        <p className="text-xs text-text-muted">Only an admin can change the browser model.</p>
      )}

      {/* ── Updates ── */}
      {current?.enabled && current.revision && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <div className={subhead}>Updates</div>
            <button onClick={handleCheckUpdates} disabled={checkingUpdates || saving} className={btnSecondary}>
              {checkingUpdates ? 'Checking…' : 'Check for updates'}
            </button>
          </div>
          {updatesError && <p className="text-xs text-amber-500">{updatesError}</p>}
          {updates && updates.length === 0 && <p className="text-xs text-text-muted">Nothing to check.</p>}
          {updates?.map((u) => (
            <div key={u.repo} className="flex flex-wrap items-center gap-2 text-xs">
              <span className={u.updateAvailable ? 'text-text font-mono' : 'text-text-muted'}>{updateLine(u)}</span>
              {canWrite && canApplyUpdate(u) &&
                (confirmUpdate === u.repo ? (
                  <>
                    <span className="text-text-muted">
                      Switch to {shortSha(u.latest)}? The new files download on next use and this model's benchmark resets.
                    </span>
                    <button onClick={() => handleApplyUpdate(u)} disabled={saving} className={btnPrimary}>
                      Update
                    </button>
                    <button onClick={() => setConfirmUpdate(null)} className={btnGhost}>
                      Cancel
                    </button>
                  </>
                ) : (
                  <button onClick={() => setConfirmUpdate(u.repo)} disabled={saving} className={btnSecondary}>
                    Apply update
                  </button>
                ))}
            </div>
          ))}
        </div>
      )}

      {/* ── Cache ── */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <div className={subhead}>Cached model files</div>
          <button onClick={() => void loadStats()} className={btnGhost}>
            Refresh
          </button>
        </div>
        {cacheNote ? (
          <p className="text-xs text-text-muted">{cacheNote}</p>
        ) : statsError ? (
          <p className="text-xs text-amber-500">Could not read the cache — {statsError}</p>
        ) : !stats ? (
          <p className="text-xs text-text-muted">The in-tab chat is not configured yet.</p>
        ) : (
          <>
            {sortedGroups.length === 0 ? (
              <p className="text-xs text-text-muted">No model files are cached in this browser.</p>
            ) : (
              <ul className="space-y-1">
                {repos.map((r) => (
                  <li key={r.repo} className="text-xs">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-text font-mono break-all">{r.repo}</span>
                      <span className="flex items-center gap-2">
                        <span className="text-text-muted">{formatBytes(r.bytes)}</span>
                        {caps.clear &&
                          (confirmClear === r.repo ? (
                            <>
                              <button onClick={() => handleClear(r.repo)} disabled={clearing} className={btnDanger}>
                                Clear
                              </button>
                              <button onClick={() => setConfirmClear(null)} className={btnGhost}>
                                Cancel
                              </button>
                            </>
                          ) : (
                            <button onClick={() => setConfirmClear(r.repo)} disabled={clearing} className={btnGhost}>
                              Clear cached files
                            </button>
                          ))}
                      </span>
                    </div>
                    {confirmClear === r.repo && (
                      <p className="text-text-muted mt-0.5">
                        Deletes this model's files from the browser cache. The next chat downloads them again.
                      </p>
                    )}
                    <ul className="ml-3 text-text-muted">
                      {sortedGroups
                        .filter((g) => g.repo === r.repo)
                        .map((g) => (
                          <li key={g.revision} className="font-mono">
                            @{shortSha(g.revision)} · {g.files.length} file{g.files.length === 1 ? '' : 's'} · {formatBytes(g.bytes)}
                            {current && g.repo === current.repo && g.revision === current.revision ? ' · current' : ''}
                          </li>
                        ))}
                    </ul>
                  </li>
                ))}
              </ul>
            )}
            <div className="text-xs text-text-muted space-y-0.5">
              <div>Total: {formatBytes(stats.totalBytes)}</div>
              <div>{persistenceLine(stats.persisted)}</div>
              <div>Cross-Origin Storage: {stats.cosActive ? 'active for this session' : 'not in use'}</div>
              {(stats.cosActive || overview.cache.crossOriginStorage) && (
                <div>Files in Cross-Origin Storage can't be deleted by this page; the browser manages them. Clear only removes the files listed above.</div>
              )}
            </div>
            {clearNote && <p className="text-xs text-text-muted">{clearNote}</p>}
          </>
        )}
      </div>

      {/* ── Cross-Origin Storage ── */}
      <div className="space-y-1">
        <div className="flex items-center justify-between gap-2">
          <div className={subhead}>Cross-Origin Storage (experimental)</div>
          {canWrite ? (
            <button
              onClick={() => handleCos(!overview.cache.crossOriginStorage)}
              disabled={cosSaving}
              aria-pressed={overview.cache.crossOriginStorage}
              className={`px-3 py-1 rounded text-xs font-medium cursor-pointer border-none disabled:opacity-50 ${
                overview.cache.crossOriginStorage ? 'bg-red/20 text-red hover:bg-red/30' : 'bg-green/20 text-green hover:bg-green/30'
              }`}
            >
              {overview.cache.crossOriginStorage ? 'Disable' : 'Enable'}
            </button>
          ) : (
            <span className="text-xs text-text-muted">{overview.cache.crossOriginStorage ? 'On' : 'Off'}</span>
          )}
        </div>
        <p className="text-xs text-text-muted">
          Shares downloaded model weights across sites and dashboard ports, so a model downloads once. Model weights only, never
          your data. Experimental: needs a browser with <span className="font-mono">navigator.crossOriginStorage</span>. Files in
          Cross-Origin Storage can't be deleted by this page.
        </p>
        {!cosInBrowser && (
          <p className="text-xs text-amber-500">
            This browser doesn't have Cross-Origin Storage{overview.cache.crossOriginStorage ? ', so the setting has no effect here' : ''}.
          </p>
        )}
        {cosError && <p className="text-xs text-red">{cosError}</p>}
      </div>

      {/* ── Benchmark ── */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <div className={subhead}>Benchmark</div>
          {!benchNote && current?.enabled && (
            <span className="flex items-center gap-2">
              {benchRunning && benchProgress && <span className="text-xs text-text-muted">{benchProgress}</span>}
              <button onClick={handleBench} disabled={benchRunning} className={btnSecondary}>
                {benchRunning ? 'Running…' : 'Run benchmark'}
              </button>
            </span>
          )}
        </div>
        {benchNote ? (
          <p className="text-xs text-text-muted">{benchNote}</p>
        ) : !current?.enabled ? (
          <p className="text-xs text-text-muted">Choose a browser model to benchmark it.</p>
        ) : bench ? (
          <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-0.5 text-xs" data-testid="browser-model-bench">
            {benchRows(bench).map((r) => (
              <div key={r.label} className="contents">
                <dt className="text-text-muted">{r.label}</dt>
                <dd className="text-text">{r.value}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="text-xs text-text-muted">No benchmark yet for this model in this browser.</p>
        )}
        {benchError && <p className="text-xs text-amber-500">Benchmark failed — {benchError}</p>}
        <p className="text-xs text-text-muted">Uses a fixed synthetic prompt, never your data. Results stay in this browser.</p>
      </div>
    </div>
  );
}
