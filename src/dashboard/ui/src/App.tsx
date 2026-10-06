import { useCallback, useEffect, useMemo } from 'react';
import { Header } from '@/components/Header';
import { TabBar } from '@/components/TabBar';
import { TAB_IDS, type TabId } from '@webmcp-session';
import { AppContext, type AppState } from '@/state';
import { useDateRange } from '@/hooks/useDateRange';
import { dropUnknownProfileIds, navigateToTab, useUrlState } from '@/hooks/useUrlState';
import { categoryFilterOptions } from '@/lib/categoryOptions';
import type { UrlTab } from '@/lib/urlState';
import { useApi } from '@/hooks/useApi';
import { useMirrorSync } from '@/hooks/useMirrorSync';
import { primeCategoryPalette } from '@/charts/palette';
import { WebMcpProvider } from '@/agent/WebMcpProvider';
import type { Account, SpendingSummaryItem, Entity } from '@/types';
import { OverviewTab } from '@/tabs/OverviewTab';
import { TransactionsTab } from '@/tabs/TransactionsTab';
import { ReviewTab } from '@/tabs/ReviewTab';
import { AccountsTab } from '@/tabs/AccountsTab';
import { ChatTab } from '@/tabs/ChatTab';
import { LlmTab } from '@/tabs/LlmTab';
import { LogsTab } from '@/tabs/LogsTab';
import { GoalsTab } from '@/tabs/GoalsTab';
import { ForecastTab } from '@/tabs/ForecastTab';
import { SettingsTab } from '@/tabs/SettingsTab';

// lib/urlState.ts parses the tab out of the URL hash from the same TAB_IDS;
// fail the build if its tab type ever drifts from the TabBar's.
type SameTabs = [(typeof TAB_IDS)[number]] extends [UrlTab] ? ([UrlTab] extends [TabId] ? true : false) : false;
const TABS_IN_SYNC: SameTabs = true;
void TABS_IN_SYNC;

const TAB_COMPONENTS: Record<TabId, React.FC> = {
  overview: OverviewTab,
  transactions: TransactionsTab,
  review: ReviewTab,
  accounts: AccountsTab,
  goals: GoalsTab,
  forecast: ForecastTab,
  chat: ChatTab,
  llm: LlmTab,
  logs: LogsTab,
  settings: SettingsTab,
};

export function App() {
  useMirrorSync();
  // Tab + header filters live in the URL hash (lib/urlState.ts) so reloads,
  // bookmarks and Back/Forward restore the view. Filter tweaks replace the
  // current history entry; tab switches push one.
  const { state: url, navigate } = useUrlState();
  const activeTab: TabId = url.tab;
  const accountId = url.account;
  const category = url.cat;
  const entityId = url.entity;
  const setAccountId = useCallback(
    (id: number | null) => navigate((s) => ({ ...s, account: id }), { mode: 'replace' }),
    [navigate],
  );
  const setCategory = useCallback(
    (cat: string | null) => navigate((s) => ({ ...s, cat: cat || null }), { mode: 'replace' }),
    [navigate],
  );
  const setEntityId = useCallback(
    (id: number | null) => navigate((s) => ({ ...s, entity: id }), { mode: 'replace' }),
    [navigate],
  );
  const { dateRange, setDateRange, goToPrevMonth, goToNextMonth, selectPreset, preset, monthLabel } = useDateRange();

  const { data: accountsData } = useApi<Account[]>('/api/accounts');
  const { data: entitiesData } = useApi<Entity[]>('/api/entities');
  // Header category options: every category label in transactions (incl.
  // Transfer / Credit Card / Payment / Income and 'Uncategorized'). Not
  // /api/summary — that applies the dashboard SPEND rule and would drop the
  // non-spend categories as filter options.
  const { data: categoryOptions } = useApi<string[]>('/api/category-options');
  // All-time spending summary: ranks categories for stable chart colors.
  const { data: allSummaryData } = useApi<SpendingSummaryItem[]>('/api/summary?startDate=2000-01-01&endDate=2099-12-31');
  // Stable chart colors: ranked by all-time spend, memoized for the session.
  useEffect(() => void primeCategoryPalette(allSummaryData), [allSummaryData]);

  const accounts = useMemo(() => accountsData ?? [], [accountsData]);
  const entities = useMemo(() => entitiesData ?? [], [entitiesData]);
  // A deep-linked category stays selected even before the options load.
  const categories = useMemo(() => categoryFilterOptions(categoryOptions, category), [categoryOptions, category]);

  // Account/entity ids are profile-scoped. Any history entry (Back after a
  // profile switch, an old bookmark) can carry another profile's ids, so once
  // this profile's lists have loaded, drop unknown ids in place (replace).
  // A list that failed to load (null) is never used to prune.
  useEffect(() => {
    dropUnknownProfileIds({
      accounts: accountsData ? accountsData.map((a) => a.id) : null,
      entities: entitiesData ? entitiesData.map((e) => e.id) : null,
    });
  }, [accountsData, entitiesData, accountId, entityId]);

  const handleTabChange = useCallback((tab: TabId) => navigateToTab(tab), []);

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
      <WebMcpProvider activeTab={activeTab} onNavigate={handleTabChange}>
        <main className="flex-1 overflow-hidden min-h-0 flex flex-col">
          <ActiveTabComponent />
        </main>
      </WebMcpProvider>
      </div>
    </AppContext.Provider>
  );
}
