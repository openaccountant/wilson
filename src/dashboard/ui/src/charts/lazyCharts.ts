// ── Charts that load on demand ───────────────────────────────────────────────
//
// recharts (with its d3 and lodash pieces) is the largest library in the app.
// The Overview tab renders its numbers and text first and draws these charts
// when this chunk arrives; each call site wraps them in <Suspense> inside a box
// that already has the chart's size, so nothing shifts when they appear.

import { lazy } from 'react';

export const SavingsSparklineChart = lazy(() =>
  import('./SavingsSparklineChart').then((m) => ({ default: m.SavingsSparklineChart })),
);
export const CashflowFanChart = lazy(() => import('./CashflowFanChart').then((m) => ({ default: m.CashflowFanChart })));
export const SpendingDonut = lazy(() => import('./SpendingDonut').then((m) => ({ default: m.SpendingDonut })));
