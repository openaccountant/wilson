const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'transactions', label: 'Transactions' },
  { id: 'accounts', label: 'Accounts' },
  { id: 'goals', label: 'Goals' },
  { id: 'chat', label: 'Chat' },
  { id: 'llm', label: 'LLM' },
  { id: 'logs', label: 'Logs' },
  { id: 'settings', label: 'Settings' },
] as const;

export type TabId = (typeof TABS)[number]['id'];

interface TabBarProps {
  activeTab: TabId;
  onTabChange: (tab: TabId) => void;
}

export function TabBar({ activeTab, onTabChange }: TabBarProps) {
  return (
    <nav className="flex gap-0 bg-surface-raised border-b border-border px-6 shrink-0">
      {TABS.map((tab) => (
        <button
          key={tab.id}
          onClick={() => onTabChange(tab.id)}
          className={`px-5 py-2.5 bg-transparent border-none text-sm font-medium cursor-pointer border-b-2 transition-all duration-150 ${
            activeTab === tab.id
              ? 'text-text border-b-green'
              : 'text-text-secondary border-b-transparent hover:text-text'
          }`}
        >
          {tab.label}
        </button>
      ))}
    </nav>
  );
}
