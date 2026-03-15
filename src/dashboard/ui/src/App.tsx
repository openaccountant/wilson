import { useState, useEffect, useCallback, useMemo } from 'react';
import { Header } from '@/components/Header';
import { TabBar, type TabId } from '@/components/TabBar';
import { AppContext, type AppState } from '@/state';
import { useDateRange } from '@/hooks/useDateRange';
import { useApi } from '@/hooks/useApi';
import type { Account, SpendingSummaryItem, Entity } from '@/types';
import { OverviewTab } from '@/tabs/OverviewTab';
import { TransactionsTab } from '@/tabs/TransactionsTab';
import { AccountsTab } from '@/tabs/AccountsTab';
import { ChatTab } from '@/tabs/ChatTab';
import { LlmTab } from '@/tabs/LlmTab';
import { LogsTab } from '@/tabs/LogsTab';
import { GoalsTab } from '@/tabs/GoalsTab';
import { SettingsTab } from '@/tabs/SettingsTab';

function getHashTab(): TabId {
  const hash = window.location.hash.replace('#', '');
  const valid: TabId[] = ['overview', 'transactions', 'accounts', 'goals', 'chat', 'llm', 'logs', 'settings'];
  return valid.includes(hash as TabId) ? (hash as TabId) : 'overview';
}

const TAB_COMPONENTS: Record<TabId, React.FC> = {
  overview: OverviewTab,
  transactions: TransactionsTab,
  accounts: AccountsTab,
  goals: GoalsTab,
  chat: ChatTab,
  llm: LlmTab,
  logs: LogsTab,
  settings: SettingsTab,
};

export function App() {
  const [activeTab, setActiveTab] = useState<TabId>(getHashTab);
  const [accountId, setAccountId] = useState<number | null>(null);
  const [category, setCategory] = useState<string | null>(null);
  const [entityId, setEntityId] = useState<number | null>(null);
  const { dateRange, setDateRange, goToPrevMonth, goToNextMonth, selectPreset, preset, monthLabel } = useDateRange();

  const { data: accountsData } = useApi<Account[]>('/api/accounts');
  const { data: entitiesData } = useApi<Entity[]>('/api/entities');
  // Fetch summary with date range so categories update when range changes
  const summaryParams = `startDate=${dateRange.startDate}&endDate=${dateRange.endDate}`;
  const { data: summaryData } = useApi<SpendingSummaryItem[]>(`/api/summary?${summaryParams}`, [summaryParams]);
  // Also fetch a wide range to populate all known categories for the dropdown
  const { data: allSummaryData } = useApi<SpendingSummaryItem[]>('/api/summary?startDate=2000-01-01&endDate=2099-12-31');

  const accounts = useMemo(() => accountsData ?? [], [accountsData]);
  const entities = useMemo(() => entitiesData ?? [], [entitiesData]);
  const categories = useMemo(() => {
    // Merge categories from current range + all-time to populate dropdown fully
    const combined = [...(summaryData ?? []), ...(allSummaryData ?? [])];
    return [...new Set(combined.map((s) => s.category).filter(Boolean))].sort();
  }, [summaryData, allSummaryData]);

  const handleTabChange = useCallback((tab: TabId) => {
    window.location.hash = tab;
    setActiveTab(tab);
  }, []);

  useEffect(() => {
    const onHashChange = () => setActiveTab(getHashTab());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const state: AppState = {
    dateRange,
    setDateRange,
    accountId,
    setAccountId,
    category,
    setCategory,
    entityId,
    setEntityId,
  };

  const ActiveTabComponent = TAB_COMPONENTS[activeTab];

  return (
    <AppContext.Provider value={state}>
      <div className="h-screen flex flex-col overflow-hidden">
      <Header
        accounts={accounts}
        categories={categories}
        entities={entities}
        monthLabel={monthLabel}
        preset={preset}
        onPrevMonth={goToPrevMonth}
        onNextMonth={goToNextMonth}
        onSelectPreset={selectPreset}
      />
      <TabBar activeTab={activeTab} onTabChange={handleTabChange} />
      <main className="flex-1 overflow-hidden min-h-0 flex flex-col">
        <ActiveTabComponent />
      </main>
      </div>
    </AppContext.Provider>
  );
}
