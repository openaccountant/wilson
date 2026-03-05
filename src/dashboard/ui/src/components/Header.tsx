import { useAppState } from '@/state';
import type { RangePreset } from '@/hooks/useDateRange';

interface HeaderProps {
  accounts: { id: number; name: string }[];
  categories: string[];
  monthLabel: string;
  preset: RangePreset;
  onPrevMonth: () => void;
  onNextMonth: () => void;
  onSelectPreset: (p: RangePreset) => void;
}

const PRESETS: { id: RangePreset; label: string }[] = [
  { id: 'month', label: 'Month' },
  { id: 'quarter', label: 'Quarter' },
  { id: 'ytd', label: 'YTD' },
  { id: 'year', label: 'Year' },
  { id: 'prev-year', label: 'Prev Year' },
];

export function Header({
  accounts,
  categories,
  monthLabel,
  preset,
  onPrevMonth,
  onNextMonth,
  onSelectPreset,
}: HeaderProps) {
  const { accountId, setAccountId, category, setCategory } = useAppState();

  return (
    <header className="flex items-center justify-between px-6 py-3 bg-surface-raised border-b border-border shrink-0">
      <h1 className="text-lg font-semibold text-text">
        <span className="text-green">$</span> Wilson
      </h1>

      <div className="flex items-center gap-3">
        {/* Preset pills */}
        <div className="flex items-center gap-0.5 bg-surface border border-border rounded-md p-0.5">
          {PRESETS.map((p) => (
            <button
              key={p.id}
              onClick={() => onSelectPreset(p.id)}
              className={`px-2 py-1 text-xs font-medium rounded cursor-pointer border-none transition-colors ${
                preset === p.id
                  ? 'bg-green/20 text-green'
                  : 'bg-transparent text-text-muted hover:text-text'
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>

        {/* Prev / label / Next */}
        <div className="flex items-center gap-1">
          <button
            onClick={onPrevMonth}
            className="px-2 py-1 text-text-muted hover:text-text bg-transparent border border-border rounded cursor-pointer"
          >
            &larr;
          </button>
          <span className="text-sm text-text min-w-[130px] text-center font-medium">
            {monthLabel}
          </span>
          <button
            onClick={onNextMonth}
            className="px-2 py-1 text-text-muted hover:text-text bg-transparent border border-border rounded cursor-pointer"
          >
            &rarr;
          </button>
        </div>

        <select
          value={accountId ?? ''}
          onChange={(e) => setAccountId(e.target.value ? Number(e.target.value) : null)}
          className="bg-border-muted text-text border border-border px-2.5 py-1.5 rounded-md text-sm"
        >
          <option value="">All accounts</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>

        <select
          value={category ?? ''}
          onChange={(e) => setCategory(e.target.value || null)}
          className="bg-border-muted text-text border border-border px-2.5 py-1.5 rounded-md text-sm"
        >
          <option value="">All categories</option>
          {categories.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </div>
    </header>
  );
}
