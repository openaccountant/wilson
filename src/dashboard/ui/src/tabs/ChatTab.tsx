import { useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo } from 'react';
import { useApi } from '@/hooks/useApi';
import { useHybridChat } from '@/hooks/useHybridChat';
import { useTypeahead, type ActiveTrigger, type AcceptMode } from '@/hooks/useTypeahead';
import {
  useMentionSources,
  useMerchantSearch,
  invalidateMentionSources,
  buildMentionCandidates,
  knownMentionLabels,
  MENTION_GROUP_ORDER,
  MENTION_EMPTY_LIMITS,
  type MentionCandidate,
} from '@/hooks/useMentionSources';
import { api, getBaseUrl } from '@/api';
import { parseTaxExportArgs } from '@/lib/taxExport';
import type { BudgetVsActualRow, ChatHistoryRow, ChatResponse, ChatSessionRow } from '@/types';
import { moneyWhole, parseDbTimestamp } from '@/format';
import { ChatMarkdown, LocalChatMarkdown } from '@/lib/chatMarkdown';
import { buildChatRequest, hasHandoffPayload } from '@/lib/chat-request';
import { syncMirror } from '@/store/mirror-client';
import type { PriorLocalTurn } from '@/hybrid/worker-protocol';
import { deriveChatProvenance, isLocalProvenance, linksRenderAsText, localUnavailableNotice, PROVENANCE_BADGES } from '@/hybrid/core';
import type { ChatProvenance, HybridResult } from '@/hybrid/core';
import { Typeahead, type TypeaheadItem } from '@/components/Typeahead';
import { ComposerBackdrop, MentionIcon } from '@/components/ComposerBackdrop';
import { ImportStatementDialog, type ImportResponse } from '@/components/ImportStatementDialog';
import { ChatApprovalCard } from '@/components/ChatApprovalCard';
import { usePendingChatApproval } from '@/hooks/usePendingChatApproval';
import { navigateToTab, navigateUrl, readUrlState, reloadForProfileSwitch, useUrlState } from '@/hooks/useUrlState';
import { withSession } from '@/lib/urlState';
import {
  applySelection,
  contextBlockLabels,
  contextBlockMentions,
  detectTrigger,
  extractMentionTokens,
  filterAndGroup,
  formatMentionToken,
  mergeRecentMention,
  parseCommand,
  pruneMentions,
  readRecentMentions,
  splitContextBlock,
  tokenEndingAt,
  writeRecentMentions,
  type MentionEntry,
  type RecentMention,
} from '@/lib/typeahead';
import {
  CHAT_COMMANDS,
  COMMAND_EMPTY_LIMITS,
  COMMAND_GROUP_ORDER,
  commandCandidates,
  helpMarkdown,
  planArgAccept,
  planCommandAccept,
  resolveCommand,
  skillCommands,
  type AcceptPlan,
  type ChatCommand,
} from '@/lib/chatCommands';

interface DisplayMessage {
  /** Stable React key (index keys re-mount bubbles when history shifts). */
  id: number;
  role: 'user' | 'assistant';
  content: string;
  /**
   * Which path produced this live response. Never persisted — history rows
   * loaded from /api/chat/sessions/:id carry no provenance and render no
   * indicator (no chat-history schema change).
   */
  provenance?: ChatProvenance;
  /**
   * Live-only note when the on-device model could not be used, e.g.
   * "Local model unavailable: … requires … shader-f16". Never persisted.
   */
  notice?: string;
  /** Reloaded from /api/chat/sessions/:id: links render as plain text (Round 3 "History links"). */
  fromHistory?: boolean;
  /** Dashboard-command exchange: ran in the browser, never sent or persisted. */
  local?: boolean;
  /** Subagent answers only: tools that ran on this device and how long each took. Live-only, never persisted. */
  localSteps?: { tool: string; ms: number }[];
  /** Labels to render as mention chips in this (user) bubble. */
  mentionLabels?: string[];
  /** Mentions sent with this (user) message — restored by ArrowUp recall. */
  mentions?: MentionEntry[];
}

/** Option item for the composer popover (commands, mentions, arg values). */
type ComposerItem = TypeaheadItem &
  (
    | { source: 'command'; command: ChatCommand }
    | { source: 'mention'; candidate: MentionCandidate }
    | { source: 'arg'; value: string }
  );

const LISTBOX_ID = 'chat-composer-listbox';
const ARG_TITLES = { profiles: 'Profiles', categories: 'Categories', skills: 'Skills' } as const;
const MAX_MENTIONS = 10;
/** On-device turns remembered for the server handoff (spec Q6: last 3, no history hydration). */
const PRIOR_LOCAL_TURNS_MAX = 3;

function storage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

function budgetTable(rows: BudgetVsActualRow[]): string {
  if (rows.length === 0) return 'No budgets set yet. Try `/budget set Dining 200`.';
  const lines = rows.map(
    (r) =>
      `| ${r.category} | ${moneyWhole(r.monthly_limit)} | ${moneyWhole(r.actual)} | ${moneyWhole(r.remaining)} | ${Math.round(r.percent_used)}%${r.over ? ' ⚠' : ''} |`,
  );
  return ['**Budgets vs. actual — this month**', '', '| Category | Limit | Spent | Left | Used |', '|---|--:|--:|--:|--:|', ...lines].join('\n');
}

/** Render user text with a green `/command` and chips for known mention tokens. */
function UserContent({ text, known }: { text: string; known: Set<string> }) {
  return (
    <>
      {extractMentionTokens(text, known).map((seg, i) => {
        if (seg.kind === 'command') {
          return (
            <span key={i} className="font-mono text-green">
              {seg.text}
            </span>
          );
        }
        if (seg.kind === 'mention') {
          return (
            <span
              key={i}
              title={seg.label}
              className="rounded px-1 py-px bg-surface/70 ring-1 ring-green-700/50 text-green font-medium"
            >
              @{seg.label}
            </span>
          );
        }
        return <span key={i}>{seg.text}</span>;
      })}
    </>
  );
}

function formatSessionDate(iso: string): string {
  const d = parseDbTimestamp(iso);
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  if (diff < 86400000) {
    return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function ChatTab() {
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [input, setInput] = useState('');
  const [caret, setCaret] = useState(0);
  const [mentions, setMentions] = useState<MentionEntry[]>([]);
  const [sending, setSending] = useState(false);
  /** True only while POST /api/chat is in flight (not the on-device path). */
  const [serverInFlight, setServerInFlight] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [progressLabel, setProgressLabel] = useState<string | null>(null);
  // `?session=<id>` is the source of truth for the open conversation, so a
  // reload or a shared link restores it. The effect below reconciles it with
  // the local state; ids the server assigns are written back (replace).
  const { state: urlState } = useUrlState();
  const urlSession = urlState.session;
  const activeSessionRef = useRef<string | null>(null);
  activeSessionRef.current = activeSessionId;
  /** Guards loadSession against a slower, superseded history fetch. */
  const loadSeq = useRef(0);
  const [importOpen, setImportOpen] = useState(false);
  const hybrid = useHybridChat();
  // Turns answered on-device in this chat, so a later server handoff can close the history gap.
  const priorLocalTurnsRef = useRef<PriorLocalTurn[]>([]);
  const { sources, loaded: sourcesLoaded, ensureLoaded } = useMentionSources();
  // The server agent blocks POST /api/chat on approval-gated tools (e.g.
  // categorize); surface that pending approval inline so the request can finish.
  const approval = usePendingChatApproval(sending && serverInFlight);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  /** The composer row — the typeahead popover is placed above it. */
  const composerRowRef = useRef<HTMLDivElement>(null);
  const nextId = useRef(1);
  /** Caret to restore after a programmatic text change (selection insert). */
  const pendingCaret = useRef<number | null>(null);

  const newId = () => nextId.current++;

  const {
    data: sessions,
    loading: sessionsLoading,
    refetch: refetchSessions,
  } = useApi<ChatSessionRow[]>('/api/chat/sessions');

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, sending, approval.operation?.id]);

  // Focus input on mount and after each send completes. Must run after commit:
  // focusing while the input is still `disabled` is a no-op.
  useEffect(() => {
    if (!sending) inputRef.current?.focus();
  }, [sending]);

  // Auto-grow the textarea (capped by max-h-40) and restore a pending caret.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
    if (pendingCaret.current !== null) {
      el.setSelectionRange(pendingCaret.current, pendingCaret.current);
      pendingCaret.current = null;
    }
    if (backdropRef.current) backdropRef.current.scrollTop = el.scrollTop;
  }, [input]);

  // ── Command + mention sources ─────────────────────────────────────────
  const allCommands = useMemo(() => [...CHAT_COMMANDS, ...skillCommands(sources.skills)], [sources.skills]);
  const baseMentionCandidates = useMemo(() => buildMentionCandidates(sources, []), [sources]);
  const knownLabels = useMemo(() => knownMentionLabels(sources), [sources]);

  // Merchant search follows the open "@" query (2+ chars, debounced in the hook).
  // (Permissive continuation here: the search only needs the candidate query.)
  const mentionTokens = useMemo(() => mentions.map((m) => m.token), [mentions]);
  const atQuery = useMemo(() => {
    const t = detectTrigger(input, caret, () => true, mentionTokens);
    return t?.kind === '@' ? t.query : null;
  }, [input, caret, mentionTokens]);
  const merchants = useMerchantSearch(atQuery);
  const mentionCandidates = useMemo(
    () => (merchants.length > 0 ? [...baseMentionCandidates, ...merchantCandidates(merchants)] : baseMentionCandidates),
    [baseMentionCandidates, merchants],
  );

  const hasMatches = useCallback(
    (query: string) => filterAndGroup(mentionCandidates, query, { groupOrder: MENTION_GROUP_ORDER }).items.length > 0,
    [mentionCandidates],
  );

  const getItems = useCallback(
    (trigger: ActiveTrigger): { items: ComposerItem[]; hidden: number } => {
      if (trigger.kind === '/') {
        const res = filterAndGroup(commandCandidates(allCommands), trigger.query, {
          groupOrder: COMMAND_GROUP_ORDER,
          emptyLimits: COMMAND_EMPTY_LIMITS,
        });
        return {
          hidden: res.hidden,
          items: res.items.map((c) => ({
            id: `cmd-${c.id}`,
            group: c.group,
            label: c.label,
            prefix: '/',
            args: c.command.args,
            detail: c.command.description,
            badge: c.command.tier === 'paid' ? { text: 'PRO', tone: 'yellow' as const } : undefined,
            mono: true,
            ranges: c.ranges,
            source: 'command' as const,
            command: c.command,
          })),
        };
      }

      if (trigger.kind === '@') {
        const recents: MentionCandidate[] = trigger.query.trim()
          ? []
          : readRecentMentions(storage()).flatMap((r) => {
              const live = mentionCandidates.find((c) => c.id === recentId(r));
              if (live) return [{ ...live, group: 'Recent' }];
              if (r.type === 'merchant' && r.key) {
                return merchantCandidates([{ label: r.key, n: 0, last: '' }]).map((m) => ({
                  ...m,
                  group: 'Recent',
                  detail: undefined,
                }));
              }
              return [];
            });
        const res = filterAndGroup(mentionCandidates, trigger.query, {
          groupOrder: MENTION_GROUP_ORDER,
          emptyLimits: MENTION_EMPTY_LIMITS,
          pinned: recents,
        });
        return {
          hidden: res.hidden,
          items: res.items.map((c) => ({
            id: `${c.group === 'Recent' ? 'recent-' : ''}${c.id}`,
            group: c.group,
            label: c.label,
            detail: c.detail,
            badge: c.badge,
            icon: <MentionIcon type={c.mention.type} />,
            ranges: c.ranges,
            source: 'mention' as const,
            candidate: c,
          })),
        };
      }

      if (trigger.kind !== 'arg') return { items: [], hidden: 0 };
      // Second-stage argument values (/profile <name>, /budget set <category>, /skill <name>).
      type ArgValue = {
        id: string;
        group: string;
        label: string;
        keywords?: string[];
        weakKeywords?: string[];
        detail?: string;
        paid?: boolean;
      };
      const values: ArgValue[] =
        trigger.source === 'profiles'
          ? sources.profiles.map((p) => ({
              id: `profile:${p}`,
              group: 'Profiles',
              label: p,
              detail: p === sources.activeProfile ? 'active' : undefined,
            }))
          : trigger.source === 'skills'
            ? skillCommands(sources.skills).map((c) => ({
                id: c.id,
                group: 'Skills',
                label: c.name.slice('skill '.length),
                weakKeywords: (c.fullDescription ?? c.description).split(/\W+/).filter((w) => w.length > 2),
                detail: c.description,
                paid: c.tier === 'paid',
              }))
            : sources.categories.map((c) => ({ id: `cat:${c.id}`, group: 'Categories', label: c.name, keywords: [c.slug] }));
      const res = filterAndGroup(values, trigger.query, {
        groupOrder: ['Profiles', 'Categories', 'Skills'],
        emptyLimits: { Skills: 40 },
      });
      return {
        hidden: res.hidden,
        items: res.items.map((v) => ({
          id: `arg-${v.id}`,
          group: v.group,
          label: v.label,
          detail: v.detail,
          badge: v.paid ? { text: 'PRO', tone: 'yellow' as const } : undefined,
          mono: trigger.source === 'skills',
          ranges: v.ranges,
          source: 'arg' as const,
          value: v.label,
        })),
      };
    },
    [allCommands, mentionCandidates, sources],
  );

  // ── Text updates ──────────────────────────────────────────────────────
  function updateText(text: string, nextCaret: number, nextMentions: MentionEntry[] = mentions) {
    setInput(text);
    setCaret(nextCaret);
    setMentions(pruneMentions(text, nextMentions));
    pendingCaret.current = nextCaret;
  }

  function clearComposer() {
    setInput('');
    setCaret(0);
    setMentions([]);
  }

  const onAccept = (item: ComposerItem, trigger: ActiveTrigger, mode: AcceptMode) => {
    if (item.source === 'command') {
      applyPlan(planCommandAccept(input, trigger, item.command, mode));
      return;
    }

    if (item.source === 'mention') {
      const m = item.candidate.mention;
      if (mentions.length >= MAX_MENTIONS) return;
      const token = formatMentionToken(m.label);
      const { text, caret: c } = applySelection(input, trigger, token);
      updateText(text, c, [...mentions, { ...m, token }]);
      const recent: RecentMention = { type: m.type, id: m.id, key: m.key, label: m.label };
      writeRecentMentions(storage(), mergeRecentMention(readRecentMentions(storage()), recent));
      return;
    }

    if (trigger.kind === 'arg') applyPlan(planArgAccept(input, trigger, item.value, mode));
  };

  function applyPlan(plan: AcceptPlan) {
    if (plan.action === 'send') {
      clearComposer();
      void handleSend(plan.text);
      return;
    }
    updateText(plan.text, plan.caret);
  }

  const ta = useTypeahead<ComposerItem>({
    value: input,
    caret,
    listboxId: LISTBOX_ID,
    getItems,
    hasMatches,
    acceptedTokens: mentionTokens,
    // At the mention limit the '@' menu stays closed (Enter sends) and the
    // hint row says why, instead of Enter silently doing nothing.
    blocked: (t) => t.kind === '@' && mentions.length >= MAX_MENTIONS,
    onAccept,
  });
  const mentionLimitHit = ta.trigger?.kind === '@' && mentions.length >= MAX_MENTIONS;

  // Ghost argument hint while the text is exactly "/cmd " with the caret at the end.
  const ghost = useMemo(() => {
    if (caret !== input.length) return null;
    const m = /^\s*\/(\S+(?: set)?) $/i.exec(input);
    if (!m) return null;
    return allCommands.find((c) => c.name === m[1].toLowerCase())?.args ?? null;
  }, [input, caret, allCommands]);

  // ── Sessions ──────────────────────────────────────────────────────────
  /** Mirror a session id into the URL; no-op if the user already left the chat tab. */
  function syncUrlSession(id: string | null, mode: 'push' | 'replace') {
    if (readUrlState().tab !== 'chat') return;
    navigateUrl((s) => withSession(s, id), { mode });
  }

  /** Sidebar pick: a user navigation (push); the URL effect does the loading. */
  function selectSession(sid: string) {
    if (sid === activeSessionId) return;
    syncUrlSession(sid, 'push');
  }

  async function loadSession(sid: string) {
    if (sid === activeSessionId) return;
    priorLocalTurnsRef.current = [];
    const seq = ++loadSeq.current;
    setActiveSessionId(sid);
    setSessionId(sid);
    try {
      const rows = await api<ChatHistoryRow[]>(`/api/chat/sessions/${sid}`);
      if (seq !== loadSeq.current) return;
      // An unknown/deleted id comes back empty (every real session has a
      // turn): fall back to a fresh chat and drop the param.
      if (rows.length === 0) throw new Error('empty session');
      const loaded: DisplayMessage[] = [];
      for (const row of rows) {
        // Persisted queries carry the server-resolved mention block: show the
        // user's words, and chip the labels the block names.
        const { block, body } = splitContextBlock(row.query);
        loaded.push({
          id: newId(),
          role: 'user',
          content: body,
          mentionLabels: contextBlockLabels(block),
          mentions: pruneMentions(body, contextBlockMentions(block)),
        });
        loaded.push({ id: newId(), role: 'assistant', content: row.answer, fromHistory: true });
      }
      setMessages(loaded);
    } catch {
      if (seq !== loadSeq.current) return;
      setMessages([]);
      setSessionId(null);
      setActiveSessionId(null);
      syncUrlSession(null, 'replace');
    }
    inputRef.current?.focus();
  }

  function resetChat() {
    priorLocalTurnsRef.current = [];
    loadSeq.current++;
    setMessages([]);
    setSessionId(null);
    setActiveSessionId(null);
    inputRef.current?.focus();
  }

  function handleNewChat() {
    resetChat();
    syncUrlSession(null, 'push');
  }

  // URL -> state: initial load, Back/Forward, a pasted link, a sidebar pick.
  // Keyed on the URL only; a server-assigned id updates state and URL together
  // so they already agree by the time this runs.
  useEffect(() => {
    if (urlSession === activeSessionRef.current) return;
    if (urlSession) void loadSession(urlSession);
    else resetChat();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlSession]);

  // ── Client-side commands (never sent to a model, never persisted) ─────
  function pushLocal(userText: string, answer: string) {
    setMessages((prev) => [
      ...prev,
      { id: newId(), role: 'user', content: userText, local: true },
      { id: newId(), role: 'assistant', content: answer, local: true },
    ]);
  }

  async function runClientCommand(cmd: ChatCommand, rest: string, raw: string) {
    switch (cmd.run.type) {
      case 'new':
        handleNewChat();
        return;
      case 'help':
        pushLocal(raw, helpMarkdown(allCommands));
        return;
      case 'import':
        setImportOpen(true);
        return;
      case 'navigate':
        // Push a tab switch that keeps the header's date range and filters.
        navigateToTab(cmd.run.hash);
        return;
      case 'budget':
        try {
          pushLocal(raw, budgetTable(await api<BudgetVsActualRow[]>('/api/budgets')));
        } catch (err) {
          pushLocal(raw, `Error: ${err instanceof Error ? err.message : 'could not load budgets'}`);
        }
        return;
      case 'profile':
        try {
          if (!rest) {
            const data = await api<{ profiles: string[]; active: string }>('/api/profiles');
            pushLocal(
              raw,
              [
                '**Profiles**',
                '',
                ...data.profiles.map((p) => `- \`${p}\`${p === data.active ? ' — active' : ''}`),
                '',
                'Switch with `/profile <name>`.',
              ].join('\n'),
            );
            return;
          }
          await api('/api/profiles/switch', { method: 'POST', body: JSON.stringify({ name: rest }) });
          invalidateMentionSources();
          pushLocal(raw, `Switched to profile \`${rest}\` — reloading…`);
          setTimeout(reloadForProfileSwitch, 300);
        } catch (err) {
          pushLocal(raw, `Error: ${err instanceof Error ? err.message : 'profile command failed'}`);
        }
        return;
      case 'export': {
        const words = rest.toLowerCase().split(/\s+/).filter(Boolean);
        if (words[0] === 'tax') {
          await exportTax(raw, words.slice(1));
          return;
        }
        const fmt = words.join(' ');
        if (fmt !== 'csv' && fmt !== 'xlsx') {
          pushLocal(raw, 'Usage: `/export csv`, `/export xlsx`, or `/export tax [year] [csv|xlsx]`.');
          return;
        }
        let token: string | null = null;
        try {
          token = window.localStorage.getItem('wilson_auth_token');
        } catch {
          token = null;
        }
        const a = document.createElement('a');
        a.href = `${getBaseUrl()}/api/export/${fmt}${token ? `?token=${encodeURIComponent(token)}` : ''}`;
        a.download = `transactions.${fmt}`;
        a.click();
        pushLocal(raw, `Downloading \`transactions.${fmt}\`…`);
        return;
      }
      case 'agent':
        return;
    }
  }

  /**
   * `/export tax` fetches first (rather than an <a href> download like the
   * other exports) so a 402/400 shows up as a chat message instead of being
   * saved to disk as a JSON "spreadsheet".
   */
  async function exportTax(raw: string, words: string[]) {
    const args = parseTaxExportArgs(words, new Date().getFullYear());
    if (!args.ok) {
      pushLocal(raw, args.error);
      return;
    }
    let token: string | null = null;
    try {
      token = window.localStorage.getItem('wilson_auth_token');
    } catch {
      token = null;
    }
    try {
      const res = await fetch(`${getBaseUrl()}/api/export/tax?year=${args.year}&format=${args.format}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string; upgradeUrl?: string };
        const upgrade = res.status === 402 && body.upgradeUrl ? ` [Upgrade to Pro](${body.upgradeUrl})` : '';
        pushLocal(raw, `${body.error ?? `Export failed (HTTP ${res.status}).`}${upgrade}`);
        return;
      }
      const filename = `schedule-c-${args.year}.${args.format}`;
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      pushLocal(raw, `Downloading \`${filename}\` — Schedule C totals by line plus every flagged deduction.`);
    } catch (err) {
      pushLocal(raw, `Error: ${err instanceof Error ? err.message : 'tax export failed'}`);
    }
  }

  function handleImported(result: ImportResponse) {
    setImportOpen(false);
    invalidateMentionSources();
    pushLocal('/import', result.message || `Imported ${result.transactionsImported} transactions.`);
  }

  // ── Send ──────────────────────────────────────────────────────────────
  async function handleSend(textOverride?: string) {
    const query = (textOverride ?? input).trim();
    if (!query || sending) return;

    // Client commands run here and never reach a model or the server chat.
    const parsed = parseCommand(query);
    const command = parsed && parsed.name ? resolveCommand(parsed, allCommands) : null;
    if (parsed && command && command.kind === 'client') {
      clearComposer();
      await runClientCommand(command, parsed.rest, query);
      inputRef.current?.focus();
      return;
    }

    const sentMentions = pruneMentions(query, mentions);
    // Commands and mentions need tools/ids → straight to the server agent;
    // the raw slash text is expanded server-side (src/dashboard/chat-commands.ts).
    const needsServer = query.startsWith('/') || sentMentions.length > 0;

    setMessages((prev) => [
      ...prev,
      { id: newId(), role: 'user', content: query, mentionLabels: sentMentions.map((m) => m.label), mentions: sentMentions },
    ]);
    clearComposer();
    setSending(true);

    // ── Local-first: try the on-device WebGPU path ────────────────────────
    // Every hybrid failure resolves {ok:false} (no WebGPU, model load or
    // generation failure, tool-call attempt, question outside the bundle) and
    // falls through to the server agent. The belt-and-braces catch guarantees
    // hybrid problems can never reach the Error: bubble below, which is
    // reserved for genuine server-path failures. When the local MODEL itself
    // failed, the reason rides along as a small note under the server answer.
    let local: {
      answer: string;
      sessionId: string | null;
      mode?: 'subagent';
      steps?: { tool: string; ms: number }[];
    } | null = null;
    let hybridResult: HybridResult | null = null;
    let notice: string | null = null;
    if (!needsServer) {
      try {
        const r: HybridResult = await hybrid.tryLocal(query, setProgressLabel, sessionId, {
          priorLocalTurns: priorLocalTurnsRef.current,
        });
        hybridResult = r;
        if (r.ok) local = { answer: r.answer, sessionId: r.sessionId, mode: r.mode, steps: r.steps };
        else notice = localUnavailableNotice(r.detail);
      } catch {
        local = null;
      }
      setProgressLabel(null);
    }

    // A cancelled on-device run (superseded or torn down) sends nothing anywhere.
    if (!local && hybridResult && !hybridResult.ok && hybridResult.reason === 'cancelled') {
      setSending(false);
      inputRef.current?.focus();
      return;
    }

    // The server request, with the on-device handoff when the subagent produced one
    // (never alongside @mentions; a handoff with nothing in it is not sent).
    const request = local ? null : buildChatRequest(query, sessionId, sentMentions, hybridResult, priorLocalTurnsRef.current);

    // Provenance of THIS exchange, decided at send time from the actual path
    // (never from message text): local answered → on-device (bundle or tools);
    // a handoff with a payload went to the server → continued; local layer was
    // in play but the server answered → fallback; hybrid layer absent, or
    // deliberately skipped for a command/mention → neutral server agent.
    // getStatus() (not the stale `status` state) is authoritative here
    // because handleSend's closure may outdate the state snapshot.
    const provenance = deriveChatProvenance({
      localAnswered: local !== null,
      hybridLayerPresent: !needsServer && hybrid.getStatus() !== 'unavailable',
      localMode: local?.mode === 'subagent' ? 'subagent' : 'bundle',
      handoffSent: hasHandoffPayload(request?.localHandoff),
    });

    try {
      if (local) {
        if (local.sessionId) {
          setSessionId(local.sessionId);
          setActiveSessionId(local.sessionId);
          syncUrlSession(local.sessionId, 'replace');
        }
        priorLocalTurnsRef.current = [...priorLocalTurnsRef.current, { q: query, a: local.answer }].slice(
          -PRIOR_LOCAL_TURNS_MAX,
        );
        setMessages((prev) => [
          ...prev,
          {
            id: newId(),
            role: 'assistant',
            content: local.answer,
            provenance,
            ...(local.steps && local.steps.length > 0 ? { localSteps: local.steps } : {}),
          },
        ]);
        refetchSessions();
      } else {
        setServerInFlight(true);
        const res = await api<ChatResponse>('/api/chat', {
          method: 'POST',
          body: JSON.stringify(request),
        });

        setSessionId(res.sessionId);
        if (res.sessionId) {
          setActiveSessionId(res.sessionId);
          syncUrlSession(res.sessionId, 'replace');
        }
        setMessages((prev) => [
          ...prev,
          { id: newId(), role: 'assistant', content: res.answer, provenance, ...(notice ? { notice } : {}) },
        ]);
        refetchSessions();
        // A server turn after on-device work may have changed data: re-sync the mirror
        // (deduplicated, never blocks the UI) so the next local lookup sees it.
        if (hybridResult && !hybridResult.ok && hybridResult.handoff) void syncMirror();
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : 'Something went wrong';
      setMessages((prev) => [
        ...prev,
        { id: newId(), role: 'assistant', content: `Error: ${errMsg}`, provenance, ...(notice ? { notice } : {}) },
      ]);
    } finally {
      setServerInFlight(false);
      setSending(false);
    }
  }

  // ── Composer events ───────────────────────────────────────────────────
  function syncCaret() {
    const el = inputRef.current;
    if (el) setCaret(el.selectionStart ?? el.value.length);
  }

  function handleChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const text = e.target.value;
    setInput(text);
    setCaret(e.target.selectionStart ?? text.length);
    setMentions((prev) => pruneMentions(text, prev));
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (ta.onKeyDown(e)) {
      e.preventDefault();
      return;
    }
    if (e.nativeEvent.isComposing) return;
    const el = e.currentTarget;

    // Atomic delete: Backspace at the end of a mention token removes all of it.
    if (e.key === 'Backspace' && !sending && el.selectionStart === el.selectionEnd && mentions.length > 0) {
      const hit = tokenEndingAt(input, el.selectionStart, mentions.map((m) => m.token));
      if (hit) {
        e.preventDefault();
        updateText(input.slice(0, hit.start) + input.slice(hit.end), hit.start);
        return;
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!sending) void handleSend();
      return;
    }

    // Recall the last message into an empty composer.
    if (e.key === 'ArrowUp' && input === '' && !sending) {
      const last = [...messages].reverse().find((m) => m.role === 'user');
      if (last) {
        e.preventDefault();
        updateText(last.content, last.content.length, last.mentions ?? []);
      }
      return;
    }

    if (e.key === 'Escape') {
      // Menu is already closed here; never wipe the draft (programmatic
      // clears can't be undone, and a double-Esc to close menus is common).
      e.preventDefault();
      el.blur();
    }
  }

  const userKnownLabels = (m: DisplayMessage) =>
    m.mentionLabels && m.mentionLabels.length > 0 ? new Set([...knownLabels, ...m.mentionLabels]) : knownLabels;

  const trigger = ta.trigger;
  const popoverTitle = trigger?.kind === '@' ? 'Mention' : trigger?.kind === 'arg' ? ARG_TITLES[trigger.source] : 'Commands';
  const noun = trigger?.kind === '@' ? 'mention' : trigger?.kind === 'arg' ? 'option' : 'command';
  const status = !ta.open
    ? ''
    : ta.items.length === 0
      ? 'No matches'
      : `${ta.items.length} ${noun}${ta.items.length === 1 ? '' : 's'}`;

  return (
    <div className="flex-1 flex overflow-hidden">
      {/* Session sidebar */}
      <div className="w-60 shrink-0 border-r border-border bg-surface-raised flex flex-col overflow-hidden">
        <div className="p-3 border-b border-border">
          <button
            onClick={handleNewChat}
            className="w-full bg-green-700 hover:bg-green-600 text-white text-sm font-medium px-3 py-2 rounded-lg transition-colors"
          >
            + New Chat
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {sessionsLoading && (
            <div className="p-3 text-xs text-text-muted">Loading...</div>
          )}
          {sessions && sessions.length === 0 && (
            <div className="p-3 text-xs text-text-muted">No sessions yet</div>
          )}
          {sessions?.map((s) => (
            <button
              key={s.id}
              onClick={() => selectSession(s.id)}
              className={`w-full text-left px-3 py-2.5 text-sm transition-colors border-l-2 ${
                activeSessionId === s.id
                  ? 'border-l-green bg-surface text-text'
                  : 'border-l-transparent text-text-secondary hover:bg-surface hover:text-text'
              }`}
            >
              <div className="truncate">{s.title || 'Untitled'}</div>
              <div className="text-xs text-text-muted mt-0.5">{formatSessionDate(s.started_at)}</div>
            </button>
          ))}
        </div>
      </div>

      {/* Main chat area */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Messages area */}
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {messages.length === 0 && (
            <div className="flex flex-col items-center justify-center h-full gap-1.5 text-text-muted text-sm">
              <span>No messages yet. Ask Wilson anything about your finances.</span>
              <span className="text-xs">
                Type <kbd className="font-mono text-green">/</kbd> for commands or{' '}
                <kbd className="font-mono text-green">@</kbd> to reference an account, category or merchant.
              </span>
            </div>
          )}

          {messages.map((msg) => (
            <div
              key={msg.id}
              className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
            >
              {msg.role === 'user' ? (
                // User text stays verbatim; only a leading /command and known @mentions are styled.
                <div className="max-w-[75%] rounded-lg px-4 py-2.5 text-sm whitespace-pre-wrap break-words bg-green-900/40 border border-green-700/50 text-text">
                  <UserContent text={msg.content} known={userKnownLabels(msg)} />
                </div>
              ) : (
                <div className="max-w-[75%] rounded-lg px-4 py-2.5 text-sm bg-surface border border-border text-text">
                  {linksRenderAsText(msg) ? (
                    // On-device answers (Round 2) and every history-loaded message (Round 3): links render as inert text.
                    <LocalChatMarkdown>{msg.content}</LocalChatMarkdown>
                  ) : (
                    <ChatMarkdown>{msg.content}</ChatMarkdown>
                  )}
                  {msg.provenance && (
                    <div
                      className={`mt-1.5 text-xs tracking-wide ${
                        isLocalProvenance(msg.provenance)
                          ? 'text-green'
                          : 'text-text-muted'
                      }`}
                    >
                      {PROVENANCE_BADGES[msg.provenance]}
                    </div>
                  )}
                  {msg.localSteps && msg.localSteps.length > 0 && (
                    <div className="mt-1 flex flex-wrap gap-1">
                      {msg.localSteps.map((st, i) => (
                        <span
                          key={i}
                          className="rounded px-1.5 py-px font-mono text-[0.7rem] bg-surface-raised border border-border-muted text-text-muted"
                          title={`${st.tool} · ${Math.round(st.ms)} ms on this device`}
                        >
                          {st.tool}
                        </span>
                      ))}
                    </div>
                  )}
                  {msg.notice && (
                    <div className="mt-0.5 text-xs text-text-muted break-words" title={msg.notice}>
                      {msg.notice}
                    </div>
                  )}
                  {msg.local && (
                    <div className="mt-1.5 text-xs tracking-wide text-text-muted">
                      dashboard command · not sent to a model
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}

          {sending && approval.operation && (
            <ChatApprovalCard
              operation={approval.operation}
              responding={approval.responding}
              error={approval.error}
              onRespond={(decision) => void approval.respond(decision)}
            />
          )}

          {sending && (
            <div className="flex justify-start">
              <div className="bg-surface border border-border rounded-lg px-4 py-2.5 text-sm text-text-muted">
                {progressLabel ? (
                  /* First-run model download / warmup progress (Track D). */
                  <span>{progressLabel}</span>
                ) : (
                  <span className="inline-flex gap-1">
                    <span className="animate-bounce" style={{ animationDelay: '0ms' }}>.</span>
                    <span className="animate-bounce" style={{ animationDelay: '150ms' }}>.</span>
                    <span className="animate-bounce" style={{ animationDelay: '300ms' }}>.</span>
                  </span>
                )}
              </div>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        {/* Input bar — `relative` anchors the typeahead popover above it. */}
        <div className="relative shrink-0 border-t border-border bg-surface-raised p-3">
          <Typeahead
            listboxId={LISTBOX_ID}
            anchorRef={composerRowRef}
            open={ta.open}
            items={ta.items}
            activeIndex={ta.activeIndex}
            title={popoverTitle}
            onActiveChange={ta.setActiveIndex}
            onSelect={(i) => ta.accept(i, 'execute')}
            footer={ta.hidden > 0 ? `+${ta.hidden} more — keep typing` : undefined}
            emptyText={sourcesLoaded ? undefined : 'Loading…'}
            status={status}
          />
          <div ref={composerRowRef} className="flex gap-2 items-end">
            <div className="relative flex-1 min-w-0 bg-surface rounded-lg">
              <ComposerBackdrop
                ref={backdropRef}
                text={input}
                mentions={mentions}
                ghost={ghost}
                command={input.trimStart().startsWith('/')}
              />
              <textarea
                ref={inputRef}
                rows={1}
                value={input}
                onChange={handleChange}
                onKeyDown={handleKeyDown}
                onSelect={syncCaret}
                onKeyUp={syncCaret}
                onClick={syncCaret}
                onScroll={(e) => {
                  if (backdropRef.current) backdropRef.current.scrollTop = e.currentTarget.scrollTop;
                }}
                onFocus={() => {
                  ta.onFocus();
                  ensureLoaded();
                }}
                onBlur={ta.onBlur}
                placeholder="Ask Wilson..."
                readOnly={sending}
                aria-label="Message Wilson"
                {...ta.comboboxProps}
                className="relative block w-full bg-transparent border border-border rounded-lg px-3 py-2 text-sm leading-5 text-text placeholder:text-text-muted focus:outline-none focus:border-green-600 resize-none overflow-y-auto max-h-40"
              />
            </div>
            <button
              onClick={() => void handleSend()}
              disabled={sending || !input.trim()}
              className="bg-green-700 hover:bg-green-600 disabled:bg-green-900/40 disabled:text-text-muted text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors"
            >
              Send
            </button>
          </div>
          <div className="mt-1.5 text-[11px] text-text-muted" role="status" aria-live="polite">
            {mentionLimitHit ? (
              <span className="text-yellow">
                Mention limit reached ({MAX_MENTIONS} per message) — Enter sends as text
              </span>
            ) : (
              <>
                <span className="font-mono text-green">/</span> commands · <span className="font-mono text-green">@</span>{' '}
                mention · Enter send · Shift+Enter newline
              </>
            )}
          </div>
        </div>
      </div>

      {importOpen && (
        <ImportStatementDialog open onClose={() => setImportOpen(false)} onImported={handleImported} />
      )}
    </div>
  );
}

function recentId(r: RecentMention): string {
  return r.type === 'merchant' ? `merchant:${r.key ?? r.label}` : `${r.type}:${r.id}`;
}

const NO_SOURCES = {
  accounts: [],
  categories: [],
  budgetLimits: [],
  goals: [],
  entities: [],
  skills: [],
  profiles: [],
  activeProfile: null,
};

function merchantCandidates(rows: Array<{ label: string; n: number; last: string }>): MentionCandidate[] {
  return buildMentionCandidates(NO_SOURCES, rows);
}
