import { useState, useEffect, useRef } from 'react';
import { useApi } from '@/hooks/useApi';
import { api } from '@/api';
import { Dialog } from '@/components/Dialog';
import { formatAmount, formatDate } from '@/format';
import {
  parseStatementContent,
  sha256Hex,
  canCommitImport,
  type ParsedStatement,
} from '@import-tools/client-import.js';

/** Mirrors ImportResult in src/dashboard/api.ts (not imported — that file pulls bun:sqlite types into the ui program). */
export interface ImportResponse {
  status: 'imported' | 'skipped' | 'failed';
  transactionsImported: number;
  transactionsSkipped: number;
  transactionsLinked?: number;
  dateRange?: { start: string; end: string };
  previouslyImported?: { filePath: string; importedAt: string; transactionCount: number | null };
  message: string;
  error?: string;
}

/** Mirrors GET /api/auth/status (cf. SettingsTab's SecuritySection). */
interface AuthStatus {
  authEnabled: boolean;
  user: { id: number; username: string; role: string } | null;
  userCount: number;
}

const IMPORTABLE_EXTENSIONS = ['.csv', '.ofx', '.qif'];

interface ParsedFile {
  statement: ParsedStatement;
  fileHash: string;
  filename: string;
}

interface ImportStatementDialogProps {
  open: boolean;
  onClose: () => void;
  /** File dropped on the Transactions tab's empty-state zone; consumed on open. */
  seedFile?: File | null;
  onSeedConsumed?: () => void;
  /** Called after a successful commit (imported OR skipped) — parent closes, refetches, banners. */
  onImported: (result: ImportResponse) => void;
}

function formatLabel(statement: ParsedStatement): string {
  return statement.format === 'csv'
    ? `${statement.bank.toUpperCase()} CSV`
    : statement.format.toUpperCase();
}

/**
 * Statement importer dialog. Everything up to the confirm button happens in the
 * browser: the file is decoded, hashed (WebCrypto) and parsed client-side — no
 * request is sent until the user explicitly clicks "Import to database".
 */
export function ImportStatementDialog({
  open,
  onClose,
  seedFile,
  onSeedConsumed,
  onImported,
}: ImportStatementDialogProps) {
  const { data: authStatus } = useApi<AuthStatus>('/api/auth/status');
  const canCommit = canCommitImport(authStatus);

  const [parsing, setParsing] = useState(false);
  const [parseError, setParseError] = useState('');
  const [parsed, setParsed] = useState<ParsedFile | null>(null);
  const [committing, setCommitting] = useState(false);
  const [commitError, setCommitError] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Fresh state each time the dialog is closed.
  useEffect(() => {
    if (!open) {
      setParsing(false);
      setParseError('');
      setParsed(null);
      setCommitting(false);
      setCommitError('');
      setDragOver(false);
    }
  }, [open]);

  // Consume a file dropped on the tab's empty-state zone.
  useEffect(() => {
    if (!open || !seedFile) return;
    onSeedConsumed?.();
    void processFile(seedFile);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, seedFile]);

  async function processFile(file: File) {
    setParseError('');
    setCommitError('');
    setParsed(null);
    setParsing(true);
    try {
      const name = file.name.toLowerCase();
      if (!IMPORTABLE_EXTENSIONS.some((ext) => name.endsWith(ext))) {
        setParseError('Unsupported file type — drop a CSV, OFX, or QIF statement.');
        return;
      }
      // Client-side only: decode → hash the exact text parsed below → parse.
      const content = await file.text();
      const fileHash = await sha256Hex(content);
      const statement = parseStatementContent(content);
      if (statement.transactions.length === 0) {
        setParseError(`No transactions found in ${file.name}.`);
        return;
      }
      setParsed({ statement, fileHash, filename: file.name });
    } catch (err) {
      setParseError(err instanceof Error ? err.message : String(err));
    } finally {
      setParsing(false);
    }
  }

  function pickFile(files: FileList | null) {
    const file = files?.[0];
    if (!file) return;
    void processFile(file);
  }

  async function handleCommit() {
    if (!parsed || committing) return;
    setCommitting(true);
    setCommitError('');
    try {
      const result = await api<ImportResponse>('/api/import', {
        method: 'POST',
        body: JSON.stringify({
          filename: parsed.filename,
          bank: parsed.statement.bank,
          fileHash: parsed.fileHash,
          transactions: parsed.statement.transactions.map((t) => ({
            date: t.date,
            description: t.description,
            amount: t.amount,
            external_id: t.external_id,
            bank: t.bank,
            merchant_name: t.merchant_name,
            category: t.category,
            category_detailed: t.category_detailed,
            payment_channel: t.payment_channel,
            pending: t.pending,
            authorized_date: t.authorized_date,
          })),
        }),
      });
      if (result.status === 'failed') {
        setCommitError(result.error ?? result.message);
        return;
      }
      onImported(result);
    } catch (err) {
      // HTTP 400 (failed import), 403 (non-admin), network errors — dialog stays open.
      setCommitError(err instanceof Error ? err.message : String(err));
    } finally {
      setCommitting(false);
    }
  }

  const preview = parsed?.statement;
  const previewRows = preview?.transactions.slice(0, 5) ?? [];

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Import statement"
      footer={
        <div className="flex items-center justify-between gap-2">
          {!canCommit && (
            <span className="text-xs text-text-muted">Importing requires an admin account.</span>
          )}
          <div className="flex items-center gap-2 ml-auto">
            <button
              onClick={onClose}
              className="bg-transparent text-text-muted border border-border px-3 py-1.5 rounded text-sm cursor-pointer hover:text-text"
            >
              Cancel
            </button>
            <button
              onClick={handleCommit}
              disabled={!parsed || !canCommit || committing}
              className="bg-green-700 hover:bg-green-600 disabled:bg-green-900/40 disabled:text-text-muted text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors cursor-pointer disabled:cursor-not-allowed border-none"
            >
              {committing ? 'Importing…' : 'Import to database'}
            </button>
          </div>
        </div>
      }
    >
      <input
        ref={fileInputRef}
        type="file"
        accept=".csv,.ofx,.qif"
        className="hidden"
        onChange={(e) => {
          pickFile(e.target.files);
          e.target.value = '';
        }}
      />

      {/* Drop / browse zone */}
      {!preview && (
        <div
          onClick={() => fileInputRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            pickFile(e.dataTransfer.files);
          }}
          className={`rounded-lg border-2 border-dashed p-8 text-center cursor-pointer transition-colors ${
            dragOver ? 'border-green bg-green/10' : 'border-border hover:border-green'
          }`}
        >
          <div className="text-3xl mb-2">📄</div>
          {parsing ? (
            <p className="text-sm text-text-muted">Parsing statement…</p>
          ) : (
            <>
              <p className="text-sm text-text">Drop a bank statement here</p>
              <p className="text-xs text-text-muted mt-1">
                CSV, OFX, or QIF — or click to browse. Parsed locally in your browser;
                nothing is sent until you confirm.
              </p>
            </>
          )}
        </div>
      )}

      {parseError && (
        <div className="mt-3 border border-red/40 bg-red/10 rounded-md px-3 py-2 text-sm text-red">
          {parseError}
        </div>
      )}

      {/* Parse preview */}
      {preview && parsed && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div className="bg-surface-raised border border-border rounded-md px-3 py-2">
              <div className="text-xs text-text-muted uppercase tracking-wide">Bank / format</div>
              <div className="text-text font-medium">{formatLabel(preview)}</div>
            </div>
            <div className="bg-surface-raised border border-border rounded-md px-3 py-2">
              <div className="text-xs text-text-muted uppercase tracking-wide">Transactions</div>
              <div className="text-text font-medium">{preview.transactions.length}</div>
            </div>
            <div className="bg-surface-raised border border-border rounded-md px-3 py-2 col-span-2">
              <div className="text-xs text-text-muted uppercase tracking-wide">Date range</div>
              <div className="text-text font-medium font-mono text-xs">
                {preview.dateRange.start} → {preview.dateRange.end}
              </div>
            </div>
          </div>

          <div className="border border-border rounded-lg overflow-hidden">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border text-text-secondary uppercase tracking-wide">
                  <th className="text-left px-3 py-2 font-medium">Date</th>
                  <th className="text-left px-3 py-2 font-medium">Description</th>
                  <th className="text-right px-3 py-2 font-medium">Amount</th>
                </tr>
              </thead>
              <tbody>
                {previewRows.map((t, i) => (
                  <tr key={i} className="border-b border-border last:border-b-0">
                    <td className="px-3 py-1.5 text-text-secondary font-mono whitespace-nowrap">
                      {formatDate(t.date)}
                    </td>
                    <td className="px-3 py-1.5 text-text truncate max-w-[220px]">{t.description}</td>
                    <td
                      className={`px-3 py-1.5 text-right font-mono whitespace-nowrap ${
                        t.amount < 0 ? 'text-red' : 'text-green'
                      }`}
                    >
                      {formatAmount(t.amount)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-between text-sm">
            <span className="text-text-muted">
              {parsed.filename}
              {preview.transactions.length > 5 && ` — +${preview.transactions.length - 5} more`}
            </span>
            <span className="text-text-muted">
              Net total{' '}
              <span className={preview.total < 0 ? 'text-red font-mono' : 'text-green font-mono'}>
                {formatAmount(preview.total)}
              </span>
            </span>
          </div>

          <button
            onClick={() => fileInputRef.current?.click()}
            className="text-xs text-text-muted hover:text-text bg-transparent border border-border rounded px-2 py-1 cursor-pointer"
          >
            Replace file
          </button>
        </div>
      )}

      {commitError && (
        <div className="mt-3 border border-red/40 bg-red/10 rounded-md px-3 py-2 text-sm text-red break-words">
          {commitError}
        </div>
      )}
    </Dialog>
  );
}
