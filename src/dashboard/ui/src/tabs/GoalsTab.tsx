import { useMemo, useState, type ChangeEvent } from 'react';
import { useApi } from '@/hooks/useApi';
import { api } from '@/api';
import { useDeclarativeTool, useHumanBusy } from '@/agent/useDeclarativeTool';
import { AgentFilledBanner, AgentOutcomeNote } from '@/components/agent/AgentFilledBanner';
import { buildCategoryOptions, buildGoalOptions, fieldLock } from '@declarative-submit';
import type { BudgetLimitRow, CategoryRow, Goal } from '@/types';
import { money } from '@/format';

interface AuthStatus {
  authEnabled: boolean;
  user: { id: number; username: string; role: string } | null;
}

/** Goal amounts are magnitudes: always shown unsigned. */
function fmt(n: number): string {
  return money(Math.abs(n));
}

function barColor(pct: number): string {
  if (pct <= 70) return '#22c55e';
  if (pct <= 90) return '#eab308';
  return '#ef4444';
}

function statusColor(status: Goal['status']): string {
  switch (status) {
    case 'active':
      return '#22c55e';
    case 'completed':
      return '#3b82f6';
    case 'paused':
      return '#eab308';
    case 'abandoned':
      return '#71717a';
  }
}

const GOAL_STATUSES: Goal['status'][] = ['active', 'paused', 'completed', 'abandoned'];

const FIELD_CLASS =
  'bg-surface-raised border border-border rounded px-2 py-1.5 text-xs text-text focus:outline-none focus:border-green';
const SUBMIT_CLASS =
  'bg-green-700 hover:bg-green-600 disabled:opacity-50 text-white text-xs font-medium px-3 py-1.5 rounded-md transition-colors cursor-pointer border-none whitespace-nowrap';

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Set one category's monthly limit. A declarative WebMCP tool (`set_budget`): a person's submit is a PUT; an
 * agent's submit is a proposal that waits for the approval card.
 */
function BudgetEditForm({
  categoryRows,
  budgets,
  onSaved,
}: {
  categoryRows: CategoryRow[];
  budgets: BudgetLimitRow[];
  onSaved: () => void;
}) {
  const [categoryId, setCategoryId] = useState('');
  const [limit, setLimit] = useState('');
  const { busy, setBusy, isBusy } = useHumanBusy();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const options = useMemo(() => buildCategoryOptions(categoryRows), [categoryRows]);
  const picked = categoryRows.find((c) => String(c.id) === categoryId);
  const current = picked ? budgets.find((b) => b.category.toLowerCase() === picked.name.toLowerCase()) : undefined;

  async function saveAsHuman() {
    const monthlyLimit = Number(limit);
    if (!picked) return setMessage({ ok: false, text: 'Pick a category.' });
    if (limit.trim() === '' || !Number.isFinite(monthlyLimit)) return setMessage({ ok: false, text: 'Enter the monthly limit as a number.' });
    setBusy(true);
    try {
      await api(`/api/budgets/${encodeURIComponent(picked.name)}`, { method: 'PUT', body: JSON.stringify({ monthlyLimit }) });
      setMessage({ ok: true, text: `Budget for ${picked.name} set to $${monthlyLimit.toFixed(2)}.` });
      setLimit('');
      onSaved();
    } catch (err) {
      setMessage({ ok: false, text: errorText(err) });
    } finally {
      setBusy(false);
    }
  }

  const declarative = useDeclarativeTool({
    tool: 'set_budget',
    // Advertised only once the category list exists, so Chrome derives the complete enum.
    ready: options.length > 0,
    onAgentCleared: () => {
      setCategoryId('');
      setLimit('');
    },
    onHumanSubmit: saveAsHuman,
    humanBusy: isBusy,
    // Refresh once the agent has its answer, never mid-call (a re-render of this form's lists cancels a running call).
    onSettled: onSaved,
  });
  const shownOptions = declarative.hold('categories', options);
  // A person's save in flight locks the fields WITHOUT `disabled` (a disabled field leaves the tool's schema and cancels a running call).
  const lock = fieldLock(busy);

  return (
    <div className="bg-surface-raised border border-border rounded-lg p-4">
      <h3 className="text-xs text-text-secondary uppercase tracking-wide mb-3">Budgets</h3>
      {budgets.length > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-4">
          {budgets.map((b) => (
            <div key={b.id} className="border border-border rounded px-2 py-1.5 text-xs">
              <div className="text-text-muted truncate">{b.category}</div>
              <div className="font-mono text-text">{fmt(b.monthly_limit)}</div>
            </div>
          ))}
        </div>
      )}
      {declarative.agentTouched && <AgentFilledBanner />}
      <form key={declarative.formKey} className="flex flex-wrap items-end gap-3" aria-label="Set a budget" {...declarative.formProps}>
        <label className={`text-xs text-text-muted ${lock.wrapperClass}`}>
          <span className="block mb-1">Category</span>
          <select name="category_id" value={categoryId} onChange={lock.guard((e: ChangeEvent<HTMLSelectElement>) => setCategoryId(e.target.value))} {...lock.fieldProps} className={`${FIELD_CLASS} min-w-[180px]`} {...declarative.field('category_id')}>
            <option value="">Choose a category…</option>
            {shownOptions.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>
        <label className={`text-xs text-text-muted ${lock.wrapperClass}`}>
          <span className="block mb-1">Monthly limit ($){current ? ` · now ${fmt(current.monthly_limit)}` : picked ? ' · none yet' : ''}</span>
          <input
            type="number"
            name="monthly_limit"
            min={0}
            max={10000000}
            step="any"
            inputMode="decimal"
            value={limit}
            onChange={lock.guard((e: ChangeEvent<HTMLInputElement>) => setLimit(e.target.value))}
            {...lock.fieldProps}
            className={`${FIELD_CLASS} w-32`}
            {...declarative.field('monthly_limit')}
          />
        </label>
        <button type="submit" disabled={busy} className={SUBMIT_CLASS}>
          Set budget
        </button>
      </form>
      {message && <p role="status" className={`mt-2 text-xs ${message.ok ? 'text-green' : 'text-red'}`}>{message.text}</p>}
      <AgentOutcomeNote outcome={declarative.outcome} />
    </div>
  );
}

/**
 * Change a goal's target amount, date or status. A declarative WebMCP tool (`update_goal`). Goal names are user
 * text, so the picker shows `#id · type · target` only.
 */
function GoalEditForm({
  goals,
  goalId,
  onGoalIdChange,
  onSaved,
}: {
  goals: Goal[];
  goalId: string;
  onGoalIdChange: (id: string) => void;
  onSaved: () => void;
}) {
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState('');
  const [status, setStatus] = useState('');
  const { busy, setBusy, isBusy } = useHumanBusy();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const options = useMemo(() => buildGoalOptions(goals), [goals]);

  async function saveAsHuman() {
    const id = Number(goalId);
    if (!Number.isInteger(id) || id <= 0) return setMessage({ ok: false, text: 'Pick a goal.' });
    const body: Record<string, unknown> = {};
    if (amount.trim() !== '') body.targetAmount = Number(amount);
    if (date !== '') body.targetDate = date;
    if (status !== '') body.status = status;
    if (Object.keys(body).length === 0) return setMessage({ ok: false, text: 'Change at least one of target amount, date or status.' });
    setBusy(true);
    try {
      await api(`/api/goals/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
      setMessage({ ok: true, text: `Goal #${id} updated.` });
      setAmount('');
      setDate('');
      setStatus('');
      onSaved();
    } catch (err) {
      setMessage({ ok: false, text: errorText(err) });
    } finally {
      setBusy(false);
    }
  }

  const declarative = useDeclarativeTool({
    tool: 'update_goal',
    ready: options.length > 0,
    onAgentCleared: () => {
      onGoalIdChange('');
      setAmount('');
      setDate('');
      setStatus('');
    },
    onHumanSubmit: saveAsHuman,
    humanBusy: isBusy,
    onSettled: onSaved,
  });
  const shownGoalOptions = declarative.hold('goals', options);
  const lock = fieldLock(busy);

  return (
    <div id="goal-edit" className="bg-surface-raised border border-border rounded-lg p-4">
      <h3 className="text-xs text-text-secondary uppercase tracking-wide mb-3">Edit a goal</h3>
      {declarative.agentTouched && <AgentFilledBanner />}
      <form key={declarative.formKey} className="flex flex-wrap items-end gap-3" aria-label="Edit a goal" {...declarative.formProps}>
        <label className={`text-xs text-text-muted ${lock.wrapperClass}`}>
          <span className="block mb-1">Goal</span>
          <select name="goal_id" value={goalId} onChange={lock.guard((e: ChangeEvent<HTMLSelectElement>) => onGoalIdChange(e.target.value))} {...lock.fieldProps} className={`${FIELD_CLASS} min-w-[220px]`} {...declarative.field('goal_id')}>
            <option value="">Choose a goal…</option>
            {shownGoalOptions.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>
        <label className={`text-xs text-text-muted ${lock.wrapperClass}`}>
          <span className="block mb-1">Target amount ($)</span>
          <input type="number" name="target_amount" min={0} max={1000000000} step="any" inputMode="decimal" value={amount} onChange={lock.guard((e: ChangeEvent<HTMLInputElement>) => setAmount(e.target.value))} {...lock.fieldProps} className={`${FIELD_CLASS} w-32`} {...declarative.field('target_amount')} />
        </label>
        <label className={`text-xs text-text-muted ${lock.wrapperClass}`}>
          <span className="block mb-1">Target date</span>
          <input type="date" name="target_date" value={date} onChange={lock.guard((e: ChangeEvent<HTMLInputElement>) => setDate(e.target.value))} {...lock.fieldProps} className={FIELD_CLASS} {...declarative.field('target_date')} />
        </label>
        <label className={`text-xs text-text-muted ${lock.wrapperClass}`}>
          <span className="block mb-1">Status</span>
          <select name="status" value={status} onChange={lock.guard((e: ChangeEvent<HTMLSelectElement>) => setStatus(e.target.value))} {...lock.fieldProps} className={FIELD_CLASS} {...declarative.field('status')}>
            <option value="">(no change)</option>
            {GOAL_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" disabled={busy} className={SUBMIT_CLASS}>
          Update goal
        </button>
      </form>
      {message && <p role="status" className={`mt-2 text-xs ${message.ok ? 'text-green' : 'text-red'}`}>{message.text}</p>}
      <AgentOutcomeNote outcome={declarative.outcome} />
    </div>
  );
}

function GoalCard({ goal, onEdit }: { goal: Goal; onEdit?: (id: number) => void }) {
  const isFinancial = goal.goal_type === 'financial';
  const pct =
    isFinancial && goal.target_amount
      ? Math.round((goal.current_amount / goal.target_amount) * 100)
      : null;

  return (
    <div className="bg-surface-raised border border-border rounded-lg p-4">
      <div className="flex items-center justify-between mb-2">
        <div className="text-sm text-text font-medium">{goal.title}</div>
        <div className="flex gap-2">
          <span
            className="text-[10px] uppercase tracking-wide font-medium px-1.5 py-0.5 rounded"
            style={{
              backgroundColor: isFinancial ? 'rgba(34,197,94,0.15)' : 'rgba(168,85,247,0.15)',
              color: isFinancial ? '#22c55e' : '#a855f7',
            }}
          >
            {goal.goal_type}
          </span>
          <span
            className="text-[10px] uppercase tracking-wide font-medium px-1.5 py-0.5 rounded"
            style={{
              backgroundColor: `${statusColor(goal.status)}22`,
              color: statusColor(goal.status),
            }}
          >
            {goal.status}
          </span>
          {onEdit && (
            <button
              type="button"
              onClick={() => onEdit(goal.id)}
              className="text-[10px] uppercase tracking-wide font-medium px-1.5 py-0.5 rounded border border-border text-text-secondary hover:text-text bg-transparent cursor-pointer"
            >
              Edit
            </button>
          )}
        </div>
      </div>

      {isFinancial && goal.target_amount != null && pct != null ? (
        <>
          <div className="flex justify-between text-xs mb-1">
            <span className="text-text-muted font-mono">
              {fmt(goal.current_amount)} / {fmt(goal.target_amount)}
            </span>
            <span className="text-text-muted">{pct}%</span>
          </div>
          <div className="h-2 bg-border-muted rounded-full overflow-hidden">
            <div
              className="h-full rounded-full transition-all duration-300"
              style={{
                width: `${Math.min(pct, 100)}%`,
                backgroundColor: barColor(pct),
              }}
            />
          </div>
          {goal.target_date && (
            <div className="text-xs text-text-muted mt-2">
              Target: {goal.target_date}
            </div>
          )}
        </>
      ) : (
        <div className="text-xs text-text-muted">
          {goal.category && <span>Category: {goal.category}</span>}
          {goal.notes && <span className="block mt-1">{goal.notes}</span>}
        </div>
      )}
    </div>
  );
}

export function GoalsTab() {
  const { data: goals, loading, refetch: refetchGoals } = useApi<Goal[]>('/api/goals');
  // GET /api/goals returns every status, so the list above also feeds the edit form (paused and completed goals included).
  // The rest of the edit forms: the categories, the budget limits.
  const { data: authStatus } = useApi<AuthStatus>('/api/auth/status');
  const { data: categoryRows } = useApi<CategoryRow[]>('/api/categories');
  const { data: budgetRows, refetch: refetchBudgets } = useApi<BudgetLimitRow[]>('/api/budgets/limits');
  const [editGoalId, setEditGoalId] = useState('');
  // The server stays the authority: this only hides the forms from a viewer, who could not use them.
  const canAct = !authStatus?.authEnabled || authStatus?.user?.role === 'admin';

  function editGoal(id: number) {
    setEditGoalId(String(id));
    document.getElementById('goal-edit')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  const { activeCount, completedCount, avgProgress, grouped } = useMemo(() => {
    if (!goals) return { activeCount: 0, completedCount: 0, avgProgress: 0, grouped: {} };

    const active = goals.filter((g) => g.status === 'active');
    const completed = goals.filter((g) => g.status === 'completed');

    const financialActive = active.filter(
      (g) => g.goal_type === 'financial' && g.target_amount
    );
    const avg =
      financialActive.length > 0
        ? Math.round(
            financialActive.reduce(
              (sum, g) => sum + (g.current_amount / (g.target_amount ?? 1)) * 100,
              0
            ) / financialActive.length
          )
        : 0;

    const order: Goal['status'][] = ['active', 'paused', 'completed', 'abandoned'];
    const groups: Record<string, Goal[]> = {};
    for (const status of order) {
      const items = goals.filter((g) => g.status === status);
      if (items.length > 0) groups[status] = items;
    }

    return { activeCount: active.length, completedCount: completed.length, avgProgress: avg, grouped: groups };
  }, [goals]);

  if (loading) {
    return (
      <div className="flex-1 overflow-y-auto p-6 space-y-4">
        <div className="grid grid-cols-3 gap-4">
          {[0, 1, 2].map((i) => (
            <div key={i} className="bg-surface-raised border border-border rounded-lg p-4">
              <div className="h-[48px] animate-pulse bg-border-muted rounded" />
            </div>
          ))}
        </div>
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <div key={i} className="bg-surface-raised border border-border rounded-lg p-4">
              <div className="h-[60px] animate-pulse bg-border-muted rounded" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-4">
      {/* Stat cards */}
      <div className="grid grid-cols-3 gap-4">
        <div className="bg-surface-raised border border-border rounded-lg p-4">
          <div className="text-xs text-text-muted uppercase tracking-wide">Active Goals</div>
          <div className="text-2xl font-bold font-mono mt-1 text-green">{activeCount}</div>
        </div>
        <div className="bg-surface-raised border border-border rounded-lg p-4">
          <div className="text-xs text-text-muted uppercase tracking-wide">Completed</div>
          <div className="text-2xl font-bold font-mono mt-1" style={{ color: '#3b82f6' }}>
            {completedCount}
          </div>
        </div>
        <div className="bg-surface-raised border border-border rounded-lg p-4">
          <div className="text-xs text-text-muted uppercase tracking-wide">Avg Progress</div>
          <div className="text-2xl font-bold font-mono mt-1 text-green">{avgProgress}%</div>
        </div>
      </div>

      {canAct && (
        <BudgetEditForm
          categoryRows={categoryRows ?? []}
          budgets={budgetRows ?? []}
          onSaved={refetchBudgets}
        />
      )}

      {canAct && (
        <GoalEditForm
          goals={goals ?? []}
          goalId={editGoalId}
          onGoalIdChange={setEditGoalId}
          onSaved={refetchGoals}
        />
      )}

      {/* Goal cards grouped by status */}
      {Object.keys(grouped).length > 0 ? (
        Object.entries(grouped).map(([status, items]) => (
          <div key={status}>
            <h3 className="text-xs text-text-secondary uppercase tracking-wide mb-2">
              {status}
            </h3>
            <div className="space-y-2">
              {items.map((goal) => (
                <GoalCard key={goal.id} goal={goal} onEdit={canAct ? editGoal : undefined} />
              ))}
            </div>
          </div>
        ))
      ) : (
        <div className="bg-surface-raised border border-border rounded-lg p-4">
          <p className="text-sm text-text-muted">
            No goals yet. Use the <code className="text-green">goal_manage</code> tool to create goals.
          </p>
        </div>
      )}
    </div>
  );
}
