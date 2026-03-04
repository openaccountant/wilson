import { openBrowser } from '../utils/browser.js';
import { formatToolResult } from '../tools/types.js';

// ── Checkout URLs ─────────────────────────────────────────────────────────────
// Override with env vars for local testing:
//   OA_CHECKOUT_ANNUAL=https://...  (annual checkout)
//   OA_CHECKOUT_MONTHLY=https://... (monthly checkout)
//   OA_CHECKOUT_URL=https://...     (overrides both)

export function getCheckoutUrl(cycle: 'annual' | 'monthly' = 'annual'): string {
  if (process.env.OA_CHECKOUT_URL) return process.env.OA_CHECKOUT_URL;
  if (cycle === 'monthly') {
    return process.env.OA_CHECKOUT_MONTHLY ?? 'https://openaccountant.ai/buy/monthly';
  }
  return process.env.OA_CHECKOUT_ANNUAL ?? 'https://openaccountant.ai/buy';
}

// ── Tool upsell (LLM tool responses) ─────────────────────────────────────────

/**
 * Return value for gated LLM tools. JSON string matching formatToolResult shape.
 * Does NOT open browser — the agent just reports the message.
 */
export function toolUpsell(feature: string): string {
  return formatToolResult({
    error: `${feature} is a Pro feature.`,
    upgradeUrl: getCheckoutUrl('annual'),
    message:
      `${feature} is a Pro feature. ` +
      `Upgrade to Pro — $99/yr ($8.25/mo). ` +
      `Run \`/upgrade\` or \`/license <key>\` if you already have one.`,
  });
}

// ── Interactive upsell (TUI slash commands) ──────────────────────────────────

/**
 * Markdown message for TUI output. Auto-opens checkout in the browser.
 */
export function interactiveUpsell(feature: string, preview?: string): string {
  openBrowser(getCheckoutUrl('annual'));

  const lines: string[] = [];
  if (preview) lines.push(preview, '');
  lines.push(
    `**${feature} is a Pro feature.**`,
    '',
    'Upgrade to Pro — $99/yr (that\'s $8.25/mo).',
    '',
    '  `/upgrade`        Open checkout',
    '  `/upgrade month`  $20/mo if you prefer',
    '',
    'Already have a key? `/license <key>`',
  );
  return lines.join('\n');
}

// ── Headless upsell (--sync, cron) ───────────────────────────────────────────

/**
 * Prints to stderr and exits. For non-interactive contexts like `--sync`.
 */
export function headlessUpsell(feature: string): never {
  console.error(
    `${feature} requires Open Accountant Pro. ` +
    `Upgrade at ${getCheckoutUrl('annual')}`
  );
  process.exit(1);
}
