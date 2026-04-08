import * as os from 'os';
import * as path from 'path';
import { z } from 'zod';
import { Database } from '../db/compat-sqlite.js';
import { runMigrations } from '../db/migrations.js';
import { insertTransactions, setBudget } from '../db/queries.js';
import { setActiveProfilePaths, getActiveProfile } from '../profile/index.js';
import type { LlmResponse, ToolDef } from '../model/types.js';
import type { LlmResult } from '../model/llm.js';

/**
 * Ensure a test profile is set so modules that call getActiveProfile() don't throw.
 * Uses a temp directory. Safe to call multiple times (idempotent).
 */
export function ensureTestProfile(): void {
  try {
    getActiveProfile();
  } catch {
    const tmpDir = path.join(os.tmpdir(), `oa-test-profile-${process.pid}`);
    setActiveProfilePaths({
      name: 'test',
      root: tmpDir,
      database: path.join(tmpDir, 'data.db'),
      settings: path.join(tmpDir, 'settings.json'),
      scratchpad: path.join(tmpDir, 'scratchpad'),
      cache: path.join(tmpDir, 'cache'),
    });
  }
}

export function createTestDb(): Database {
  ensureTestProfile();
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

/** Build a YYYY-MM-DD string relative to today. */
export function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

/** Current month as YYYY-MM. */
export function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

/** First day of current month as YYYY-MM-DD. */
export function currentMonthStart(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}

/** Last day of current month as YYYY-MM-DD. */
export function currentMonthEnd(): string {
  const d = new Date();
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0);
  return last.toISOString().slice(0, 10);
}

/** Previous month as YYYY-MM. */
export function previousMonth(): string {
  const d = new Date();
  d.setMonth(d.getMonth() - 1);
  return d.toISOString().slice(0, 7);
}

export function seedTestData(db: Database): void {
  insertTransactions(db, [
    { date: daysAgo(10), description: 'Grocery Store', amount: -85.50, category: 'Groceries' },
    { date: daysAgo(8), description: 'Electric Company', amount: -120.00, category: 'Utilities' },
    { date: daysAgo(6), description: 'Restaurant', amount: -45.00, category: 'Dining' },
    { date: daysAgo(4), description: 'Unknown Purchase', amount: -30.00 },
    { date: daysAgo(3), description: 'Grocery Store', amount: -92.00, category: 'Groceries' },
    { date: daysAgo(2), description: 'Gas Station', amount: -55.00, category: 'Transportation' },
    { date: daysAgo(30), description: 'Paycheck', amount: 3500.00, category: 'Income' },
  ]);
  setBudget(db, 'Groceries', 200);
  setBudget(db, 'Dining', 100);
}

/** Temp file path for filesystem tests. */
export function makeTmpPath(ext: string): string {
  return path.join(os.tmpdir(), `wilson-test-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
}

/**
 * Create a mock LlmResult sequence. Each call returns the next response.
 */
export function mockCallLlm(responses: Partial<LlmResult>[]): () => Promise<LlmResult> {
  let index = 0;
  return async (): Promise<LlmResult> => {
    const res = responses[Math.min(index, responses.length - 1)];
    index++;
    return {
      response: res.response ?? { content: '', toolCalls: [] },
      usage: res.usage,
      interactionId: res.interactionId ?? null,
    };
  };
}

/**
 * Create a mock ToolDef with a given name and function.
 */
export function mockTool(name: string, fn: (args: unknown) => Promise<string>): ToolDef {
  return {
    name,
    description: `Mock tool: ${name}`,
    schema: z.object({}).passthrough(),
    func: fn,
  };
}

/**
 * Drain an async generator into an array.
 */
export async function collectEvents<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const events: T[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

/** Seed transactions that trigger spike detection in anomaly tests. */
export function seedSpikeData(db: Database, merchant: string): void {
  const baseDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const txns = [];
  for (let i = 0; i < 4; i++) {
    const d = new Date(baseDate.getTime() + i * 7 * 24 * 60 * 60 * 1000);
    txns.push({ date: d.toISOString().slice(0, 10), description: merchant, amount: -25, category: 'Other' });
  }
  txns.push({ date: new Date().toISOString().slice(0, 10), description: merchant, amount: -250, category: 'Other' });
  insertTransactions(db, txns);
}
