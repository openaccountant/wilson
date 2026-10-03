import { describe, expect, test } from 'bun:test';
import { expandSlashCommand, SYNC_QUERY, SERVER_HELP } from '../dashboard/chat-commands.js';
import { handleChatMessage } from '../dashboard/chat.js';

describe('expandSlashCommand', () => {
  test('/skill matches the CLI string (src/cli.ts)', () => {
    expect(expandSlashCommand('/skill tax-prep')).toEqual({ query: 'Use the skill "tax-prep"' });
    expect(expandSlashCommand('/skill tax-prep for 2025 please')).toEqual({
      query: 'Use the skill "tax-prep". for 2025 please',
    });
  });

  test('/skill without a name is a usage hint, not a model call', () => {
    expect('direct' in expandSlashCommand('/skill')).toBe(true);
  });

  test('/sync matches the CLI string (src/cli.ts)', () => {
    expect(SYNC_QUERY).toBe('Sync my bank transactions using the plaid_sync tool');
    expect(expandSlashCommand('/sync')).toEqual({ query: SYNC_QUERY });
  });

  test('/categorize with and without a limit', () => {
    expect(expandSlashCommand('/categorize')).toEqual({ query: 'Categorize my uncategorized transactions' });
    expect(expandSlashCommand('/categorize 50')).toEqual({
      query: 'Categorize my uncategorized transactions (limit 50)',
    });
    expect(expandSlashCommand('/categorize lots')).toEqual({ query: 'Categorize my uncategorized transactions' });
    expect(expandSlashCommand('/categorize 0')).toEqual({ query: 'Categorize my uncategorized transactions' });
  });

  test('/budget set <category> <amount>', () => {
    expect(expandSlashCommand('/budget set Dining 200')).toEqual({ query: 'Set my monthly budget for Dining to $200' });
    expect(expandSlashCommand('/budget set Personal Care $1,250.50')).toEqual({
      query: 'Set my monthly budget for Personal Care to $1250.50',
    });
    expect('direct' in expandSlashCommand('/budget set Dining')).toBe(true);
    expect('direct' in expandSlashCommand('/budget set')).toBe(true);
  });

  test('/help and unknown commands answer directly', () => {
    expect(expandSlashCommand('/help')).toEqual({ direct: SERVER_HELP });
    expect(expandSlashCommand('/frobnicate now')).toEqual({ direct: 'Unknown command `/frobnicate`. Try `/help`.' });
    const ui = expandSlashCommand('/import');
    expect('direct' in ui && ui.direct).toContain('dashboard action');
  });

  test('non-command text passes through unchanged', () => {
    for (const text of ['how much on dining?', '/', '/ 2', '/r/personalfinance says hi', '1/2/26 rent']) {
      expect(expandSlashCommand(text)).toEqual({ query: text });
    }
  });

  test('direct answers never reach the LLM (handleChatMessage short-circuits)', async () => {
    // No initChatSession → any agent call would answer "Chat session not initialized."
    const help = await handleChatMessage('/help', 'sess-1');
    expect(help).toEqual({ answer: SERVER_HELP, sessionId: 'sess-1' });
    const unknown = await handleChatMessage('/nope');
    expect(unknown.answer).toBe('Unknown command `/nope`. Try `/help`.');
  });
});
