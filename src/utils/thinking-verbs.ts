export const THINKING_VERBS = [
  'Analyzing', 'Auditing', 'Balancing', 'Budgeting',
  'Calculating', 'Categorizing', 'Checking', 'Classifying',
  'Comparing', 'Computing', 'Crunching', 'Evaluating',
  'Examining', 'Forecasting', 'Itemizing', 'Ledgering',
  'Matching', 'Organizing', 'Processing', 'Projecting',
  'Puzzling', 'Reconciling', 'Reviewing', 'Scanning',
  'Sorting', 'Summarizing', 'Tallying', 'Tracking',
  'Verifying',
] as const;

export function getRandomThinkingVerb(): string {
  return THINKING_VERBS[Math.floor(Math.random() * THINKING_VERBS.length)];
}
