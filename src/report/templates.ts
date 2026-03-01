/**
 * Default section order for the Markdown report.
 */
export const DEFAULT_SECTIONS = [
  'summary',
  'spending',
  'budget',
  'anomalies',
  'savings',
  'transactions',
] as const;

export type ReportSection = (typeof DEFAULT_SECTIONS)[number] | 'all';
