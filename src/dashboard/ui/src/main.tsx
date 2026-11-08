import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AuthGate } from './components/AuthGate';
import './styles/app.css';
import { parseHash } from './lib/urlState';
import { prefetchAllTabsWhenIdle, prefetchTab } from './tabs/lazyTabs';

// Start the URL's tab chunk now, in parallel with the login check, instead of after the app shell renders.
prefetchTab(parseHash(window.location.hash).tab);
prefetchAllTabsWhenIdle();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthGate />
  </StrictMode>,
);
