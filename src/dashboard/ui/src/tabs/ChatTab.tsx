import { useState, useRef, useEffect } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useApi } from '@/hooks/useApi';
import { useHybridChat } from '@/hooks/useHybridChat';
import { api } from '@/api';
import type { ChatHistoryRow, ChatResponse, ChatSessionRow } from '@/types';
import type { HybridResult } from '@/hybrid/core';

interface DisplayMessage {
  role: 'user' | 'assistant';
  content: string;
}

// Markdown element map for assistant replies, tuned to the Forensic Noir theme.
// Note: react-markdown escapes raw HTML by default and strips javascript: URLs —
// do NOT add rehype-raw; that is the XSS boundary for model output.
const markdownComponents: Components = {
  h1: ({ node: _node, ...props }) => (
    <h1 {...props} className="text-base font-bold mt-3 mb-1.5 first:mt-0" />
  ),
  h2: ({ node: _node, ...props }) => (
    <h2 {...props} className="text-[0.95rem] font-semibold mt-3 mb-1.5 first:mt-0" />
  ),
  h3: ({ node: _node, ...props }) => (
    <h3 {...props} className="text-sm font-semibold mt-2.5 mb-1 first:mt-0" />
  ),
  p: ({ node: _node, ...props }) => (
    <p {...props} className="my-2 first:mt-0 last:mb-0 leading-relaxed" />
  ),
  ul: ({ node: _node, ...props }) => (
    <ul {...props} className="list-disc pl-5 my-2 space-y-1 first:mt-0 last:mb-0" />
  ),
  ol: ({ node: _node, ...props }) => (
    <ol {...props} className="list-decimal pl-5 my-2 space-y-1 first:mt-0 last:mb-0" />
  ),
  li: ({ node: _node, ...props }) => (
    <li {...props} className="marker:text-green [&:has(>input)]:list-none" />
  ),
  strong: ({ node: _node, ...props }) => <strong {...props} className="font-semibold" />,
  em: ({ node: _node, ...props }) => <em {...props} className="italic" />,
  del: ({ node: _node, ...props }) => <del {...props} className="text-text-muted line-through" />,
  blockquote: ({ node: _node, ...props }) => (
    <blockquote
      {...props}
      className="border-l-2 border-green/50 pl-3 my-2 text-text-secondary italic first:mt-0 last:mb-0"
    />
  ),
  hr: ({ node: _node, ...props }) => <hr {...props} className="border-border my-3" />,
  a: ({ node: _node, href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-green underline underline-offset-2 hover:text-green/80"
    >
      {children}
    </a>
  ),
  pre: ({ node: _node, children }) => (
    <pre className="bg-bg border border-border-muted rounded-lg p-3 my-2 overflow-x-auto font-mono text-xs leading-relaxed first:mt-0 last:mb-0">
      {children}
    </pre>
  ),
  code: ({ className, children }) => {
    // Fenced blocks come through as <pre><code class="language-*">; inline code does not.
    const isBlock = /language-/.test(className ?? '') || String(children).includes('\n');
    if (isBlock) return <code className={className}>{children}</code>;
    return (
      <code className="font-mono text-[0.85em] bg-surface-raised border border-border-muted rounded px-1 py-0.5">
        {children}
      </code>
    );
  },
  table: ({ node: _node, children }) => (
    <div className="overflow-x-auto my-2 first:mt-0 last:mb-0">
      <table className="w-full text-xs border-collapse">{children}</table>
    </div>
  ),
  thead: ({ node: _node, ...props }) => <thead {...props} className="bg-surface-raised" />,
  th: ({ node: _node, ...props }) => (
    <th {...props} className="border border-border px-2 py-1.5 text-left font-semibold text-text" />
  ),
  td: ({ node: _node, ...props }) => (
    <td {...props} className="border border-border px-2 py-1 text-text" />
  ),
  // GFM task-list checkbox (rendered disabled by remark-gfm)
  input: ({ node: _node, ...props }) => (
    <input {...props} readOnly className="mr-1.5 align-middle accent-green" />
  ),
};

function formatSessionDate(iso: string): string {
  const d = new Date(iso);
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
  const [sending, setSending] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [progressLabel, setProgressLabel] = useState<string | null>(null);
  const hybrid = useHybridChat();

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const {
    data: sessions,
    loading: sessionsLoading,
    refetch: refetchSessions,
  } = useApi<ChatSessionRow[]>('/api/chat/sessions');

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, sending]);

  // Focus input on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  async function loadSession(sid: string) {
    if (sid === activeSessionId) return;
    setActiveSessionId(sid);
    setSessionId(sid);
    try {
      const rows = await api<ChatHistoryRow[]>(`/api/chat/sessions/${sid}`);
      const loaded: DisplayMessage[] = [];
      for (const row of rows) {
        loaded.push({ role: 'user', content: row.query });
        loaded.push({ role: 'assistant', content: row.answer });
      }
      setMessages(loaded);
    } catch {
      setMessages([]);
    }
    inputRef.current?.focus();
  }

  function handleNewChat() {
    setMessages([]);
    setSessionId(null);
    setActiveSessionId(null);
    inputRef.current?.focus();
  }

  async function handleSend() {
    const query = input.trim();
    if (!query || sending) return;

    setMessages((prev) => [...prev, { role: 'user', content: query }]);
    setInput('');
    setSending(true);

    // ── Local-first: try the on-device WebGPU path ────────────────────────
    // Every hybrid failure resolves {ok:false} (no WebGPU, model load or
    // generation failure, tool-call attempt, question outside the bundle) and
    // falls through to the server agent silently. The belt-and-braces catch
    // guarantees hybrid problems can never reach the Error: bubble below,
    // which is reserved for genuine server-path failures.
    let local: { answer: string; sessionId: string | null } | null = null;
    try {
      const r: HybridResult = await hybrid.tryLocal(query, setProgressLabel, sessionId);
      if (r.ok) local = { answer: r.answer, sessionId: r.sessionId };
    } catch {
      local = null;
    }
    setProgressLabel(null);

    try {
      if (local) {
        if (local.sessionId) {
          setSessionId(local.sessionId);
          setActiveSessionId(local.sessionId);
        }
        setMessages((prev) => [...prev, { role: 'assistant', content: local.answer }]);
        refetchSessions();
      } else {
        const body: { query: string; sessionId?: string } = { query };
        if (sessionId) body.sessionId = sessionId;

        const res = await api<ChatResponse>('/api/chat', {
          method: 'POST',
          body: JSON.stringify(body),
        });

        setSessionId(res.sessionId);
        if (res.sessionId) setActiveSessionId(res.sessionId);
        setMessages((prev) => [...prev, { role: 'assistant', content: res.answer }]);
        refetchSessions();
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : 'Something went wrong';
      setMessages((prev) => [
        ...prev,
        { role: 'assistant', content: `Error: ${errMsg}` },
      ]);
    } finally {
      setSending(false);
      inputRef.current?.focus();
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

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
              onClick={() => loadSession(s.id)}
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
            <div className="flex items-center justify-center h-full text-text-muted text-sm">
              No messages yet. Ask Wilson anything about your finances.
            </div>
          )}

          {messages.map((msg, i) => (
            <div
              key={i}
              className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
            >
              {msg.role === 'user' ? (
                // User messages stay verbatim plain text.
                <div className="max-w-[75%] rounded-lg px-4 py-2.5 text-sm whitespace-pre-wrap bg-green-900/40 border border-green-700/50 text-text">
                  {msg.content}
                </div>
              ) : (
                <div className="max-w-[75%] rounded-lg px-4 py-2.5 text-sm bg-surface border border-border text-text">
                  <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                    {msg.content}
                  </ReactMarkdown>
                </div>
              )}
            </div>
          ))}

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

        {/* Input bar */}
        <div className="shrink-0 border-t border-border bg-surface-raised p-3">
          <div className="flex gap-2">
            <input
              ref={inputRef}
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Ask Wilson..."
              disabled={sending}
              className="flex-1 bg-surface border border-border rounded-lg px-3 py-2 text-sm text-text placeholder:text-text-muted focus:outline-none focus:border-green-600 disabled:opacity-50"
            />
            <button
              onClick={handleSend}
              disabled={sending || !input.trim()}
              className="bg-green-700 hover:bg-green-600 disabled:bg-green-900/40 disabled:text-text-muted text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors"
            >
              Send
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
