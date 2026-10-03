/**
 * Server-side expansion of dashboard chat slash commands.
 *
 * The browser sends the raw slash text ("/categorize 50"); this module turns
 * it into the natural-language query the agent runs, so the dashboard,
 * WebMCP and plain HTTP callers all share one implementation. Strings that
 * also exist in the terminal CLI are kept in parity with src/cli.ts.
 *
 * Returns `{ query }` to run through the agent, `{ direct }` to answer
 * without calling any model (help, usage errors, unknown commands), or
 * `{ action }` for a command that runs one tool directly, as the CLI does.
 */

export type SlashExpansion =
  | { query: string }
  | { direct: string }
  | { action: 'categorize'; limit?: number };

/** Mirrors src/cli.ts (`/sync` routes the agent to the plaid_sync tool). */
export const SYNC_QUERY = 'Sync my bank transactions using the plaid_sync tool';

/** Commands that only run in the dashboard UI (never through the agent). */
const UI_ONLY = new Set([
  'new', 'clear', 'import', 'profile', 'export',
  'overview', 'transactions', 'review', 'accounts', 'goals', 'forecast', 'settings', 'logs', 'llm', 'model',
]);

export const SERVER_HELP = [
  '**Agent commands**',
  '',
  '- `/categorize [n]` — AI-categorize uncategorized transactions',
  '- `/sync` — pull latest transactions from linked banks',
  '- `/budget` — budgets vs. actual this month',
  '- `/budget set <category> <amount>` — set a monthly budget',
  '- `/skill <name> [args]` — run a skill',
  '',
  'In the dashboard, type `/` for the full list (navigation, import, export, profiles) and `@` to mention an account, category, merchant, goal or entity.',
].join('\n');

const COMMAND_NAME = /^[a-z][\w-]*$/i;

function money(raw: string): number | null {
  const n = Number(raw.replace(/^\$/, '').replace(/,/g, ''));
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export function expandSlashCommand(text: string): SlashExpansion {
  const trimmed = text.trim();
  const m = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(trimmed);
  // Not a command (plain text, "/" alone, "/r/personalfinance …") → passthrough.
  if (!m || !COMMAND_NAME.test(m[1])) return { query: text };

  const name = m[1].toLowerCase();
  const rest = (m[2] ?? '').trim();

  switch (name) {
    case 'help':
      return { direct: SERVER_HELP };

    case 'skill': {
      const [skill, ...more] = rest.split(/\s+/).filter(Boolean);
      if (!skill) return { direct: 'Usage: `/skill <name> [args]`. Type `/` in the dashboard to browse skills.' };
      const extra = more.join(' ');
      return { query: `Use the skill "${skill}"${extra ? `. ${extra}` : ''}` };
    }

    case 'categorize': {
      // Runs the categorize tool directly, like src/cli.ts — never the agent
      // loop, whose full tool-schema prompt overwhelms local models.
      const n = /^\d+$/.test(rest) ? parseInt(rest, 10) : null;
      return n && n > 0 ? { action: 'categorize', limit: n } : { action: 'categorize' };
    }

    case 'sync':
      return { query: SYNC_QUERY };

    case 'budget': {
      if (!rest) return { query: 'Show my budgets vs. actual spending for this month' };
      const set = /^set\s+(.+?)\s+(\$?[\d,]+(?:\.\d+)?)$/i.exec(rest);
      if (set) {
        const amount = money(set[2]);
        const category = set[1].trim();
        if (amount !== null && category) {
          return { query: `Set my monthly budget for ${category} to $${Number.isInteger(amount) ? amount : amount.toFixed(2)}` };
        }
      }
      return { direct: 'Usage: `/budget set <category> <amount>` — e.g. `/budget set Dining 200`.' };
    }

    default:
      if (UI_ONLY.has(name)) {
        return { direct: `\`/${name}\` is a dashboard action — it runs in the browser, not through the agent.` };
      }
      return { direct: `Unknown command \`/${name}\`. Try \`/help\`.` };
  }
}
