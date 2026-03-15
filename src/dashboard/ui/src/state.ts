import { createContext, useContext } from 'react';
import type { DateRange } from './types';

export interface AppState {
  dateRange: DateRange;
  setDateRange: (range: DateRange) => void;
  accountId: number | null;
  setAccountId: (id: number | null) => void;
  category: string | null;
  setCategory: (cat: string | null) => void;
  entityId: number | null;
  setEntityId: (id: number | null) => void;
}

export const AppContext = createContext<AppState | null>(null);

export function useAppState(): AppState {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useAppState must be used within AppContext.Provider');
  return ctx;
}
