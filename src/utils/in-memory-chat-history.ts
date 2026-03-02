import { createHash } from 'crypto';
import { callLlm, DEFAULT_MODEL } from '../model/llm.js';
import {
  DEFAULT_HISTORY_LIMIT,
  FULL_ANSWER_TURNS,
  type HistoryEntry,
} from './history-context.js';
import { z } from 'zod';
import type { Database } from '../db/compat-sqlite.js';
import { insertChatMessage, updateChatAnswer, getRecentChatHistory, createChatSession, updateSessionTitle } from '../db/queries.js';

/**
 * Represents a single conversation turn (query + answer + summary)
 */
export interface Message {
  id: number;
  query: string;
  answer: string | null;   // null until answer completes
  summary: string | null;  // LLM-generated summary, null until answer arrives
}

/**
 * Schema for LLM to select relevant messages
 */
export const SelectedMessagesSchema = z.object({
  message_ids: z.array(z.number()).describe('List of relevant message IDs (0-indexed)'),
});

/**
 * System prompt for generating message summaries
 */
const MESSAGE_SUMMARY_SYSTEM_PROMPT = `You are a concise summarizer. Generate brief summaries of conversation answers.
Keep summaries to 1-2 sentences that capture the key information.`;

/**
 * System prompt for selecting relevant messages
 */
const MESSAGE_SELECTION_SYSTEM_PROMPT = `You are a relevance evaluator. Select which previous conversation messages are relevant to the current query.
Return only message IDs that contain information directly useful for answering the current query.`;

/**
 * Manages in-memory conversation history for multi-turn conversations.
 * Stores user queries, final answers, and LLM-generated summaries.
 */
export class InMemoryChatHistory {
  private messages: Message[] = [];
  private model: string;
  private readonly maxTurns: number;
  private relevantMessagesByQuery: Map<string, Message[]> = new Map();
  private db: Database | null = null;
  private lastDbId: number | null = null;
  private sessionId: string | null = null;
  private sessionTitled: boolean = false;

  constructor(model: string = DEFAULT_MODEL, maxTurns: number = DEFAULT_HISTORY_LIMIT) {
    this.model = model;
    this.maxTurns = maxTurns;
  }

  /**
   * Enable SQLite persistence. Session is created lazily on first message,
   * avoiding empty session records when the CLI starts but no chat occurs.
   */
  setDatabase(db: Database): void {
    this.db = db;
  }

  /**
   * Ensure a session exists, creating one lazily on first use.
   */
  private ensureSession(): void {
    if (this.sessionId || !this.db) return;
    try {
      this.sessionId = createChatSession(this.db);
    } catch {
      this.sessionId = null;
    }
  }

  /**
   * Returns the current session ID (for API/dashboard use).
   */
  getSessionId(): string | null {
    return this.sessionId;
  }

  /**
   * Switch to an existing session (e.g., when dashboard user selects a prior session).
   * New messages will be appended to this session.
   */
  setSessionId(sessionId: string): void {
    this.sessionId = sessionId;
    this.sessionTitled = true; // existing sessions already have titles
  }

  /**
   * Hashes a query string for cache key generation
   */
  private hashQuery(query: string): string {
    return createHash('md5').update(query).digest('hex').slice(0, 12);
  }

  /**
   * Updates the model used for LLM calls (e.g., when user switches models)
   */
  setModel(model: string): void {
    this.model = model;
  }

  /**
   * Generates a brief summary of an answer for later relevance matching
   */
  private async generateSummary(query: string, answer: string): Promise<string> {
    const answerPreview = answer.slice(0, 1500); // Limit for prompt size

    const prompt = `Query: "${query}"
Answer: "${answerPreview}"

Generate a brief 1-2 sentence summary of this answer.`;

    try {
      const { response } = await callLlm(prompt, {
        systemPrompt: MESSAGE_SUMMARY_SYSTEM_PROMPT,
        model: this.model,
        callType: 'summarize',
      });
      return response.content.trim();
    } catch {
      // Fallback to a simple summary if LLM fails
      return `Answer to: ${query.slice(0, 100)}`;
    }
  }

  /**
   * Saves a new user query to history immediately (before answer is available).
   * Answer and summary are null until saveAnswer() is called with the answer.
   */
  saveUserQuery(query: string): void {
    // Clear the relevance cache since message history has changed
    this.relevantMessagesByQuery.clear();

    this.messages.push({
      id: this.messages.length,
      query,
      answer: null,
      summary: null,
    });

    // Persist to DB (lazily creates session on first message)
    if (this.db) {
      try {
        this.ensureSession();
        this.lastDbId = insertChatMessage(this.db, query, null, null, this.sessionId);
      } catch {
        this.lastDbId = null;
      }
    }
  }

  /**
   * Saves the answer to the most recent message and generates a summary.
   * Should be called when the agent completes answering.
   */
  async saveAnswer(answer: string): Promise<void> {
    const lastMessage = this.messages[this.messages.length - 1];
    if (!lastMessage || lastMessage.answer !== null) {
      return; // No pending query or already has answer
    }

    lastMessage.answer = answer;
    lastMessage.summary = await this.generateSummary(lastMessage.query, answer);

    // Persist to DB
    if (this.db && this.lastDbId !== null) {
      try {
        updateChatAnswer(this.db, this.lastDbId, answer, lastMessage.summary);
        // Auto-title the session from the first Q&A
        if (!this.sessionTitled && this.sessionId) {
          const title = lastMessage.summary || lastMessage.query.slice(0, 100);
          updateSessionTitle(this.db, this.sessionId, title);
          this.sessionTitled = true;
        }
      } catch {
        // Ignore persistence errors
      }
      this.lastDbId = null;
    }
  }

  /**
   * Uses LLM to select which messages are relevant to the current query.
   * Results are cached by query hash to avoid redundant LLM calls within the same query.
   * Only considers messages with completed answers for relevance selection.
   */
  async selectRelevantMessages(currentQuery: string): Promise<Message[]> {
    // Only consider messages with completed answers
    const completedMessages = this.messages.filter((m) => m.answer !== null);
    if (completedMessages.length === 0) {
      return [];
    }

    // Check cache first
    const cacheKey = this.hashQuery(currentQuery);
    const cached = this.relevantMessagesByQuery.get(cacheKey);
    if (cached) {
      return cached;
    }

    const messagesInfo = completedMessages.map((message) => ({
      id: message.id,
      query: message.query,
      summary: message.summary,
    }));

    const prompt = `Current user query: "${currentQuery}"

Previous conversations:
${JSON.stringify(messagesInfo, null, 2)}

Select which previous messages are relevant to understanding or answering the current query.`;

    try {
      const { response } = await callLlm(prompt, {
        systemPrompt: MESSAGE_SELECTION_SYSTEM_PROMPT,
        model: this.model,
        outputSchema: SelectedMessagesSchema,
        callType: 'relevance',
      });

      const structured = response.structured as { message_ids: number[] } | undefined;
      const selectedIds = structured?.message_ids || [];

      const selectedMessages = selectedIds
        .filter((idx) => idx >= 0 && idx < this.messages.length)
        .map((idx) => this.messages[idx])
        .filter((m) => m.answer !== null); // Ensure we only return completed messages

      // Cache the result
      this.relevantMessagesByQuery.set(cacheKey, selectedMessages);

      return selectedMessages;
    } catch {
      // On failure, return empty (don't inject potentially irrelevant context)
      return [];
    }
  }

  /**
   * Formats selected messages for task planning (queries + summaries only, lightweight)
   */
  formatForPlanning(messages: Message[]): string {
    if (messages.length === 0) {
      return '';
    }

    return messages
      .map((message) => `User: ${message.query}\nAssistant: ${message.summary}`)
      .join('\n\n');
  }

  /**
   * Formats selected messages for answer generation (queries + full answers)
   */
  formatForAnswerGeneration(messages: Message[]): string {
    if (messages.length === 0) {
      return '';
    }

    return messages
      .map((message) => `User: ${message.query}\nAssistant: ${message.answer}`)
      .join('\n\n');
  }

  /**
   * Returns all messages
   */
  getMessages(): Message[] {
    return [...this.messages];
  }

  /**
   * Returns user queries in chronological order (no LLM call)
   */
  getUserMessages(): string[] {
    return this.messages.map((message) => message.query);
  }

  /**
   * Returns recent completed turns as alternating user/assistant entries.
   * Uses full answers for the most recent turns and summaries for older ones.
   */
  getRecentTurns(limit: number = this.maxTurns): HistoryEntry[] {
    const boundedLimit = Math.max(0, limit);
    if (boundedLimit === 0) {
      return [];
    }

    const completedMessages = this.messages.filter((message) => message.answer !== null);
    const recentMessages = completedMessages.slice(-boundedLimit);

    return recentMessages.flatMap((message, index) => {
      const isRecentTurn = index >= recentMessages.length - FULL_ANSWER_TURNS;
      const assistantContent = isRecentTurn
        ? message.answer
        : (message.summary ?? message.answer);

      return [
        { role: 'user', content: message.query },
        { role: 'assistant', content: assistantContent ?? '' },
      ];
    });
  }

  /**
   * Returns true if there are any messages
   */
  hasMessages(): boolean {
    return this.messages.length > 0;
  }

  /**
   * Clears all messages and cache
   */
  clear(): void {
    this.messages = [];
    this.relevantMessagesByQuery.clear();
  }
}
