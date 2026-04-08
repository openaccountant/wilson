import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';

/**
 * Represents a conversation entry (user message + agent response pair)
 * Uses stack ordering: most recent at index 0
 */
export interface ConversationEntry {
  id: string;
  timestamp: string;
  userMessage: string;
  agentResponse: string | null;
}

interface MessagesFile {
  messages: ConversationEntry[];
}

const OA_DIR = '.openaccountant';
const MESSAGES_DIR = 'messages';
const MESSAGES_FILE = 'chat_history.json';

export interface LongTermChatHistoryInstance {
  load(): Promise<void>;
  addUserMessage(message: string): Promise<void>;
  updateAgentResponse(response: string): Promise<void>;
  getMessages(): ConversationEntry[];
  getMessageStrings(): string[];
}

/**
 * Creates a persistent conversation history manager.
 * Uses stack ordering (most recent first) for O(1) access to latest entries.
 * Stores messages in .openaccountant/messages/chat_history.json
 */
export function LongTermChatHistory(baseDir: string = process.cwd()): LongTermChatHistoryInstance {
  const filePath = join(baseDir, OA_DIR, MESSAGES_DIR, MESSAGES_FILE);
  let messages: ConversationEntry[] = [];
  let loaded = false;

  async function save(): Promise<void> {
    const dir = dirname(filePath);
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }
    const data: MessagesFile = { messages };
    await writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
  }

  async function load(): Promise<void> {
    if (loaded) return;
    try {
      if (existsSync(filePath)) {
        const content = await readFile(filePath, 'utf-8');
        const data: MessagesFile = JSON.parse(content);
        messages = data.messages || [];
      } else {
        messages = [];
        await save();
      }
    } catch {
      messages = [];
    }
    loaded = true;
  }

  async function addUserMessage(message: string): Promise<void> {
    if (!loaded) await load();
    const entry: ConversationEntry = {
      id: Date.now().toString(),
      timestamp: new Date().toISOString(),
      userMessage: message,
      agentResponse: null,
    };
    messages.unshift(entry);
    await save();
  }

  async function updateAgentResponse(response: string): Promise<void> {
    if (!loaded) await load();
    if (messages.length > 0) {
      messages[0].agentResponse = response;
      await save();
    }
  }

  function getMessages(): ConversationEntry[] {
    return [...messages];
  }

  function getMessageStrings(): string[] {
    const result: string[] = [];
    for (const m of messages) {
      const lastMessage = result[result.length - 1];
      if (lastMessage !== m.userMessage) {
        result.push(m.userMessage);
      }
    }
    return result;
  }

  return { load, addUserMessage, updateAgentResponse, getMessages, getMessageStrings };
}
