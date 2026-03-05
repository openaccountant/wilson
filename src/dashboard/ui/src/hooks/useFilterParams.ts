import { useAppState } from '@/state';

/**
 * Build a query string from the shared date range, account, and category filters.
 * Components use this to ensure API calls respect the header controls.
 */
export function useFilterParams(): string {
  const { dateRange, accountId, category } = useAppState();
  const parts: string[] = [
    `startDate=${dateRange.startDate}`,
    `endDate=${dateRange.endDate}`,
  ];
  if (accountId != null) parts.push(`accountId=${accountId}`);
  if (category) parts.push(`category=${encodeURIComponent(category)}`);
  return parts.join('&');
}
