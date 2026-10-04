/**
 * Chart design tokens, read from the Tailwind `@theme` CSS variables in
 * styles/app.css so charts (SVG fills/strokes that can't take utility
 * classes) stay in sync with the stylesheet. Fallbacks mirror app.css and are
 * used outside a browser (bun tests) or before the stylesheet has loaded.
 */

export const TOKEN_FALLBACKS = {
  bg: '#0f1117',
  surface: '#1a1d27',
  surfaceRaised: '#161b22',
  border: '#2a2d37',
  borderMuted: '#21262d',
  text: '#e4e4e7',
  textMuted: '#71717a',
  textSecondary: '#8b949e',
  green: '#22c55e',
  red: '#ef4444',
  yellow: '#eab308',
  chart1: '#3987e5',
  chart2: '#d95926',
  chart3: '#199e70',
  chart4: '#c98500',
  chart5: '#d55181',
  chart6: '#008300',
  chart7: '#9085e9',
  chartNeutral: '#5b6170',
  chartNeutralBar: '#7a8090',
  chartGrid: '#2a2d37',
  chartAxis: '#8b949e',
  chartTooltipBg: '#1a1d27',
  chartUncovered: '#1a1d27',
} as const;

export type TokenName = keyof typeof TOKEN_FALLBACKS;

/** camelCase token name → CSS custom property ('chartNeutral' → '--color-chart-neutral'). */
export function cssVarName(name: TokenName): string {
  const kebab = name.replace(/([a-z])([A-Z0-9])/g, '$1-$2').toLowerCase();
  return `--color-${kebab}`;
}

export type ChartTokens = Record<TokenName, string>;

let cached: ChartTokens | null = null;

/** Resolve every token once per session (CSS vars don't change at runtime here). */
export function chartTokens(): ChartTokens {
  if (cached) return cached;
  const out = { ...TOKEN_FALLBACKS } as ChartTokens;
  if (typeof window === 'undefined' || typeof getComputedStyle !== 'function') return out;
  const style = getComputedStyle(document.documentElement);
  let resolvedAny = false;
  for (const name of Object.keys(TOKEN_FALLBACKS) as TokenName[]) {
    const v = style.getPropertyValue(cssVarName(name)).trim();
    if (v) {
      out[name] = v;
      resolvedAny = true;
    }
  }
  // Only memoize once the stylesheet is actually applied.
  if (resolvedAny) cached = out;
  return out;
}

/** Categorical series slots 1-7, in fixed (validated) order. */
export function seriesSlots(tokens: ChartTokens = chartTokens()): string[] {
  return [tokens.chart1, tokens.chart2, tokens.chart3, tokens.chart4, tokens.chart5, tokens.chart6, tokens.chart7];
}
