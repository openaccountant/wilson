import { TAB_IDS, type TabId } from '@webmcp-session';

// The ids live in one place (TAB_IDS, shared with the server's tab-scoped tools); only the labels are here.
const TAB_LABELS: Record<TabId, string> = {
  overview: 'Overview',
  transactions: 'Transactions',
  review: 'Review',
  accounts: 'Accounts',
  goals: 'Goals',
  forecast: 'Forecast',
  chat: 'Chat',
  llm: 'LLM',
  logs: 'Logs',
  settings: 'Settings',
};

export type { TabId };

interface TabBarProps {
  activeTab: TabId;
  onTabChange: (tab: TabId) => void;
}

export function TabBar({ activeTab, onTabChange }: TabBarProps) {
  return (
    <nav className="flex gap-0 bg-surface-raised border-b border-border px-6 shrink-0">
      {TAB_IDS.map((id) => (
        <button
          key={id}
          onClick={() => onTabChange(id)}
          className={`px-5 py-2.5 bg-transparent border-none text-sm font-medium cursor-pointer border-b-2 transition-all duration-150 ${
            activeTab === id
              ? 'text-text border-b-green'
              : 'text-text-secondary border-b-transparent hover:text-text'
          }`}
        >
          {TAB_LABELS[id]}
        </button>
      ))}
    </nav>
  );
}
