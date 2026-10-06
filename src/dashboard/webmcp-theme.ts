/**
 * Forensic Noir constants for the vanilla in-page bridge (no Tailwind there).
 * They mirror the dashboard's own tokens in ui/src/styles/app.css, and a test
 * (webmcp-theme.test.ts) fails if the two drift. Import-free.
 *
 * Green is for action and value, amber for permissions, red for danger only
 * (app/BRAND.md). Square-ish: 6px radius, never a pill.
 */
export interface Theme {
  bg: string;
  surface: string;
  border: string;
  text: string;
  muted: string;
  green: string;
  red: string;
  amber: string;
  mono: string;
  sans: string;
  radius: string;
}

export const THEME: Readonly<Theme> = {
  /** Panel background: `--color-surface-raised`. */
  bg: '#161b22',
  /** Inset blocks and inputs: `--color-surface`. */
  surface: '#1a1d27',
  border: '#2a2d37',
  text: '#e4e4e7',
  muted: '#71717a',
  green: '#22c55e',
  red: '#ef4444',
  /** Permissions and warnings: `--color-yellow`. */
  amber: '#eab308',
  mono: "'JetBrains Mono', ui-monospace, monospace",
  sans: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  radius: '6px',
};
