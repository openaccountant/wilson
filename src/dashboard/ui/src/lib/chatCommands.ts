/**
 * Client-side slash-command registry for the dashboard chat composer.
 * Pure data + descriptors (no React) so Bun tests can pin its invariants.
 *
 * kind 'client' commands run in the browser and are never sent to a model.
 * kind 'agent' commands are POSTed verbatim to /api/chat, where
 * src/dashboard/chat-commands.ts expands them (one implementation shared by
 * the dashboard, WebMCP and plain HTTP callers).
 */
import { applySelection, type ArgTrigger, type Candidate, type ParsedCommand } from './typeahead.js';

export type CommandGroup = 'Actions' | 'Navigation' | 'Skills';
export type CommandKind = 'client' | 'agent';

export type CommandRun =
  | { type: 'new' }
  | { type: 'help' }
  | { type: 'import' }
  | { type: 'budget' }
  | { type: 'profile' }
  | { type: 'export' }
  | { type: 'navigate'; hash: string }
  | { type: 'agent' };

export interface ChatCommand {
  id: string;
  /** Name as typed after the slash; may contain a space ("budget set"). */
  name: string;
  /** Argument hint, e.g. '[n]', '<category> <amount>'. */
  args?: string;
  /** Human-facing one-liner (menu detail, /help). */
  description: string;
  /** Full agent-facing text (skills' SKILL.md description) — search only. */
  fullDescription?: string;
  group: CommandGroup;
  kind: CommandKind;
  aliases?: string[];
  tier?: 'free' | 'paid';
  /** Enter inserts but does not execute until args are typed. */
  requiresArgs?: boolean;
  run: CommandRun;
}

const nav = (name: string, description: string, aliases?: string[]): ChatCommand => ({
  id: `nav-${name}`,
  name,
  description,
  group: 'Navigation',
  kind: 'client',
  aliases,
  run: { type: 'navigate', hash: name },
});

export const CHAT_COMMANDS: ChatCommand[] = [
  // ── Actions (client) ──
  { id: 'new', name: 'new', description: 'Start a new chat', group: 'Actions', kind: 'client', aliases: ['clear'], run: { type: 'new' } },
  { id: 'help', name: 'help', description: 'List commands and skills', group: 'Actions', kind: 'client', run: { type: 'help' } },
  { id: 'import', name: 'import', description: 'Import a bank statement (CSV, OFX, QIF)', group: 'Actions', kind: 'client', run: { type: 'import' } },
  { id: 'budget', name: 'budget', description: 'Budgets vs. actual this month', group: 'Actions', kind: 'client', run: { type: 'budget' } },
  { id: 'profile', name: 'profile', args: '[name]', description: 'List profiles, or switch to one', group: 'Actions', kind: 'client', run: { type: 'profile' } },
  { id: 'export', name: 'export', args: '<csv|xlsx|tax [year]>', description: 'Download transactions, or a Schedule C tax export', group: 'Actions', kind: 'client', requiresArgs: true, run: { type: 'export' } },
  // ── Actions (agent) ──
  { id: 'categorize', name: 'categorize', args: '[n]', description: 'AI-categorize uncategorized transactions', group: 'Actions', kind: 'agent', run: { type: 'agent' } },
  { id: 'sync', name: 'sync', description: 'Pull latest transactions from linked banks', group: 'Actions', kind: 'agent', run: { type: 'agent' } },
  { id: 'budget-set', name: 'budget set', args: '<category> <amount>', description: 'Set a monthly budget', group: 'Actions', kind: 'agent', requiresArgs: true, run: { type: 'agent' } },
  { id: 'skill', name: 'skill', args: '<name> [args]', description: 'Run a skill', group: 'Actions', kind: 'agent', requiresArgs: true, run: { type: 'agent' } },
  // ── Navigation ──
  nav('overview', 'Go to Overview'),
  nav('transactions', 'Go to Transactions'),
  nav('review', 'Go to the review queue'),
  nav('accounts', 'Go to Accounts'),
  nav('goals', 'Go to Goals'),
  nav('forecast', 'Go to Forecast'),
  nav('settings', 'Go to Settings (models, profiles, agent access)', ['model']),
  nav('logs', 'Go to Logs'),
  nav('llm', 'Go to LLM traces'),
];

/** CLI-only commands that make no sense in the browser. Never registered here. */
export const HIDDEN_CLI_COMMANDS = ['pull', 'connect', 'connect-coinbase', 'dashboard', 'license', 'upgrade', 'exit', 'quit'];

/** Wire shape of GET /api/skills. */
export interface SkillInfo {
  name: string;
  description: string;
  tier: 'free' | 'paid';
  source: string;
}

/**
 * SKILL.md descriptions are written for the agent ("… Trigger when user asks
 * about 1099s …"). Humans get the first sentence, cut before any
 * "Trigger when" / "Use when" routing hint.
 */
export function humanSkillDescription(description: string): string {
  const text = description.replace(/\\(?=[&*_`])/g, '').replace(/\s+/g, ' ').trim();
  const cut = text.search(/\b(?:trigger|use|invoke) (?:this )?(?:skill )?when\b/i);
  const head = (cut > 0 ? text.slice(0, cut) : text).trim();
  const sentence = /^(.+?[.!?])(?:\s|$)/.exec(head)?.[1] ?? head;
  return sentence.trim() || text;
}

export function skillCommands(skills: SkillInfo[]): ChatCommand[] {
  return skills.map((s) => ({
    id: `skill-${s.name}`,
    name: `skill ${s.name}`,
    description: humanSkillDescription(s.description),
    fullDescription: s.description.trim(),
    group: 'Skills' as const,
    kind: 'agent' as const,
    tier: s.tier,
    run: { type: 'agent' as const },
  }));
}

/**
 * Resolve parsed `/name rest` to a registry entry. Two-word names
 * ("budget set", "skill x") win over the one-word form; aliases resolve too.
 */
export function resolveCommand(parsed: ParsedCommand, commands: ChatCommand[] = CHAT_COMMANDS): ChatCommand | null {
  const first = parsed.rest.split(/\s+/)[0]?.toLowerCase() ?? '';
  if (first) {
    const two = `${parsed.name} ${first}`;
    const hit = commands.find((c) => c.name === two);
    if (hit) return hit;
  }
  return (
    commands.find((c) => c.name === parsed.name) ??
    commands.find((c) => c.aliases?.includes(parsed.name)) ??
    null
  );
}

export interface CommandCandidate extends Candidate {
  command: ChatCommand;
}

export const COMMAND_GROUP_ORDER: CommandGroup[] = ['Actions', 'Navigation', 'Skills'];

/** Empty-query curation for "/": all Actions, Navigation, then 6 Skills. */
export const COMMAND_EMPTY_LIMITS: Record<string, number> = { Actions: 40, Navigation: 40, Skills: 6 };

/**
 * Typeahead candidates for a "/" trigger. "/" only triggers at the start of
 * the message (detectTrigger), where every command — client or agent — is
 * runnable: the server expands only a leading slash (expandSlashCommand).
 */
export function commandCandidates(commands: ChatCommand[]): CommandCandidate[] {
  return commands
    .map((c) => ({
      id: c.id,
      group: c.group,
      label: c.name,
      keywords: c.aliases ?? [],
      weakKeywords:
        c.group === 'Skills' ? (c.fullDescription ?? c.description).split(/\W+/).filter((w) => w.length > 2) : [],
      command: c,
    }));
}

/** Markdown for the local /help bubble. */
export function helpMarkdown(commands: ChatCommand[]): string {
  const line = (c: ChatCommand) =>
    `- \`/${c.name}${c.args ? ` ${c.args}` : ''}\` — ${c.description}${c.tier === 'paid' ? ' (PRO)' : ''}${
      c.aliases?.length ? ` _(alias: ${c.aliases.map((a) => `/${a}`).join(', ')})_` : ''
    }`;
  const section = (g: CommandGroup, title: string) => {
    const list = commands.filter((c) => c.group === g);
    return list.length ? `**${title}**\n\n${list.map(line).join('\n')}` : '';
  };
  return [
    section('Actions', 'Actions'),
    section('Navigation', 'Navigation'),
    section('Skills', 'Skills'),
    '`@` mentions an account, category, merchant, goal or entity so Wilson uses its exact id.',
  ]
    .filter(Boolean)
    .join('\n\n');
}

// ── Accepting a menu option (pure; ChatTab applies the plan) ───────────────

/** Send `text` as a message now, or put `text` in the composer with the caret at `caret`. */
export type AcceptPlan = { action: 'send'; text: string } | { action: 'insert'; text: string; caret: number };

/** Enter on a leading command without required args runs it right away; Tab only inserts. */
export function planCommandAccept(
  input: string,
  trigger: { start: number; end: number; kind: string; leading?: boolean },
  cmd: ChatCommand,
  mode: 'insert' | 'execute',
): AcceptPlan {
  const { text, caret } = applySelection(input, trigger, `/${cmd.name}`);
  const leading = trigger.kind === '/' && trigger.leading === true;
  if (mode === 'execute' && leading && !cmd.requiresArgs) return { action: 'send', text };
  return { action: 'insert', text, caret };
}

/**
 * Second-stage argument value (/profile <name>, /budget set <category>,
 * /skill <name>). Always inserts — even on Enter — so a single keypress can
 * never switch profiles (and reload) or start a skill run; the user reviews
 * the completed command and presses Enter again to send it.
 */
export function planArgAccept(input: string, trigger: ArgTrigger, value: string, _mode: 'insert' | 'execute'): AcceptPlan {
  const { text, caret } = applySelection(input, trigger, value);
  return { action: 'insert', text, caret };
}
