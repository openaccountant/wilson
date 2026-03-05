import { useState, useRef, useEffect } from 'react';
import { useApi } from '@/hooks/useApi';
import { api } from '@/api';
import type { ChatHistoryRow, ChatResponse, ChatSessionRow } from '@/types';

interface DisplayMessage {
  role: 'user' | 'assistant';
  content: string;
}

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

    try {
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
              <div
                className={`max-w-[75%] rounded-lg px-4 py-2.5 text-sm whitespace-pre-wrap ${
                  msg.role === 'user'
                    ? 'bg-green-900/40 border border-green-700/50 text-text'
                    : 'bg-surface border border-border text-text'
                }`}
              >
                {msg.content}
              </div>
            </div>
          ))}

          {sending && (
            <div className="flex justify-start">
              <div className="bg-surface border border-border rounded-lg px-4 py-2.5 text-sm text-text-muted">
                <span className="inline-flex gap-1">
                  <span className="animate-bounce" style={{ animationDelay: '0ms' }}>.</span>
                  <span className="animate-bounce" style={{ animationDelay: '150ms' }}>.</span>
                  <span className="animate-bounce" style={{ animationDelay: '300ms' }}>.</span>
                </span>
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
