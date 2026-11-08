import { describe, expect, test } from 'bun:test';
import { adoptSession, reconcileUrlSession, type SessionHolder } from '../dashboard/ui/src/lib/chatSessionSync.js';

// Mirrors ChatTab: a send in a new chat adopts the server-assigned id, writes it to the URL, and the
// URL effect then runs. That effect must not reload the session (which clears the just-sent turn, #183).
function simulateSend(reply: { sessionId: string | null }) {
  const holder: SessionHolder = { current: null };
  let messages = ['user: first question'];
  const urlEffect = (urlSession: string | null) => {
    const action = reconcileUrlSession(urlSession, holder);
    if (action === 'load') messages = []; // loadSession of an id the store has no rows for yet -> cleared
    if (action === 'reset') messages = [];
  };
  if (reply.sessionId) {
    adoptSession(holder, reply.sessionId); // before the URL write
    urlEffect(reply.sessionId); // URL store re-renders with the new id
  } else {
    urlEffect(null); // error reply: nothing adopted, URL unchanged
  }
  messages.push('assistant: reply');
  return messages;
}

describe('chat session sync (#183)', () => {
  test('stubbed reply that assigns a session id keeps the first user turn', () => {
    expect(simulateSend({ sessionId: 'sess-1' })).toEqual(['user: first question', 'assistant: reply']);
  });

  test('error reply (no session id) keeps the first user turn', () => {
    expect(simulateSend({ sessionId: null })).toEqual(['user: first question', 'assistant: reply']);
  });

  test('a genuine navigation to another session still loads it', () => {
    const holder: SessionHolder = { current: 'a' };
    expect(reconcileUrlSession('b', holder)).toBe('load');
  });

  test('URL cleared while a session is open resets the chat; matching URL is a no-op', () => {
    const holder: SessionHolder = { current: 'a' };
    expect(reconcileUrlSession(null, holder)).toBe('reset');
    expect(reconcileUrlSession('a', holder)).toBe('none');
    expect(reconcileUrlSession(null, { current: null })).toBe('none');
  });
});

describe('why the holder is never re-derived at render (#183 root cause)', () => {
  test('a render-derived holder (the old code) sees the adopted id as foreign and reloads', () => {
    const staleState: string | null = null; // state not committed when the URL store re-renders
    const renderDerived: SessionHolder = { current: staleState };
    expect(reconcileUrlSession('sess-1', renderDerived)).toBe('load');
    const adopted: SessionHolder = { current: null };
    adoptSession(adopted, 'sess-1');
    expect(reconcileUrlSession('sess-1', adopted)).toBe('none');
  });
});
