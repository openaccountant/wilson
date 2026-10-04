import { Dialog } from '@/components/Dialog';
import { useApi } from '@/hooks/useApi';
import { transactionsHash } from '@/lib/drill';
import { merchantTransactionsPath } from '@/lib/spendingApi';
import { formatDate, money } from '@/format';
import type { Transaction } from '@/types';
import type { DrillCtx } from './drillContext';

const LOOKUP_PAGE = 500;

/**
 * L4 — transaction drawer over L3. The row comes from the L3 page already on
 * screen; after a reload (or a row on another page) it is looked up in the
 * merchant's spend rows (merchantExact). Esc / × / backdrop close it via
 * `onClose`, which goes Back when this app pushed the entry.
 */
export function TxnDrawer({
  ctx,
  known,
  onClose,
}: {
  ctx: DrillCtx;
  known: readonly Transaction[];
  onClose: () => void;
}) {
  const id = ctx.drill.txn;
  const fromPage = id != null ? known.find((t) => t.id === id) : undefined;
  const lookupPath =
    id != null && !fromPage && ctx.drill.merchant
      ? merchantTransactionsPath({
          startDate: ctx.startDate,
          endDate: ctx.endDate,
          merchant: ctx.drill.merchant,
          cat: ctx.drill.cat,
          accountId: ctx.accountId,
          entityId: ctx.entityId,
          page: 0,
          pageSize: LOOKUP_PAGE,
        })
      : null;
  const { data: lookup, loading } = useApi<Transaction[]>(lookupPath);
  const tx = fromPage ?? lookup?.find((t) => t.id === id) ?? null;

  const fields: Array<[string, React.ReactNode]> = tx
    ? [
        ['Date', formatDate(tx.date)],
        ['Amount', <span className={tx.amount < 0 ? 'text-red' : 'text-green'}>{money(tx.amount)}</span>],
        ['Description', tx.description],
        ['Merchant', tx.merchant_name ?? '—'],
        ['Category', tx.category ?? 'Uncategorized'],
        ['Detailed category', tx.category_detailed ?? '—'],
        ['Account', tx.account_name ?? '—'],
        ['Status', tx.pending ? 'Pending' : 'Posted'],
        [
          'Categorized by',
          tx.user_verified
            ? 'You (verified)'
            : tx.category_confidence != null
              ? `Model, ${Math.round(tx.category_confidence * 100)}% confidence`
              : 'Bank / import',
        ],
        ['ID', <span className="font-mono">{tx.id}</span>],
      ]
    : [];

  return (
    <Dialog
      open={id != null}
      onClose={onClose}
      title={tx ? tx.merchant_name ?? tx.description : 'Transaction'}
      footer={
        id != null ? (
          <div className="flex justify-end">
            <a
              href={transactionsHash(ctx.url, { cat: ctx.drill.cat, merchant: ctx.drill.merchant, txn: id })}
              className="text-xs text-green hover:underline"
            >
              Open in Transactions →
            </a>
          </div>
        ) : undefined
      }
    >
      {tx ? (
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm m-0">
          {fields.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-text-secondary text-xs pt-0.5">{k}</dt>
              <dd className="m-0 text-text break-words">{v}</dd>
            </div>
          ))}
        </dl>
      ) : loading ? (
        <p className="text-sm text-text-secondary m-0">Loading…</p>
      ) : (
        <p className="text-sm text-text-secondary m-0">This transaction isn’t in the current view.</p>
      )}
    </Dialog>
  );
}
