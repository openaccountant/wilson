import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { mkdirSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import * as os from 'os';
import { Scratchpad } from '../agent/scratchpad.js';
import { setActiveProfilePaths, resetActiveProfile } from '../profile/index.js';

describe('Scratchpad', () => {
  // Use a temp directory so scratchpad files don't pollute the project
  const tmpDir = join(os.tmpdir(), `scratchpad-test-${Date.now()}`);

  beforeAll(() => {
    mkdirSync(tmpDir, { recursive: true });
    // Point the active profile's scratchpad dir at our temp dir
    setActiveProfilePaths({
      name: 'test',
      root: tmpDir,
      database: join(tmpDir, 'data.db'),
      settings: join(tmpDir, 'settings.json'),
      scratchpad: join(tmpDir, 'scratchpad'),
      cache: join(tmpDir, 'cache'),
    });
  });

  afterAll(() => {
    resetActiveProfile();
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  test('constructor creates scratchpad file', () => {
    const sp = new Scratchpad('test query');
    expect(existsSync(join(tmpDir, 'scratchpad'))).toBe(true);
  });

  test('canCallTool returns allowed with no warning under limit', () => {
    const sp = new Scratchpad('test', { maxCallsPerTool: 3, similarityThreshold: 0.7 });
    const status = sp.canCallTool('search');
    expect(status.allowed).toBe(true);
    expect(status.warning).toBeUndefined();
  });

  test('canCallTool warns when approaching limit', () => {
    const sp = new Scratchpad('approaching limit', { maxCallsPerTool: 3, similarityThreshold: 0.7 });
    sp.recordToolCall('search');
    sp.recordToolCall('search');
    // 2 calls done, limit is 3, next would be the 3rd (last before limit)
    const status = sp.canCallTool('search');
    expect(status.allowed).toBe(true);
    expect(status.warning).toContain('approaching');
  });

  test('canCallTool warns when over limit', () => {
    const sp = new Scratchpad('over limit', { maxCallsPerTool: 2, similarityThreshold: 0.7 });
    sp.recordToolCall('search');
    sp.recordToolCall('search');
    const status = sp.canCallTool('search');
    expect(status.allowed).toBe(true); // Still allowed, just warned
    expect(status.warning).toContain('suggested limit');
  });

  test('canCallTool warns on similar query (Jaccard)', () => {
    const sp = new Scratchpad('similarity test', { maxCallsPerTool: 5, similarityThreshold: 0.5 });
    sp.recordToolCall('search', 'find grocery transactions');
    const status = sp.canCallTool('search', 'find grocery transactions nearby');
    expect(status.allowed).toBe(true);
    expect(status.warning).toContain('similar');
  });

  test('canCallTool no warning for different queries', () => {
    const sp = new Scratchpad('different queries', { maxCallsPerTool: 5, similarityThreshold: 0.7 });
    sp.recordToolCall('search', 'find grocery transactions');
    const status = sp.canCallTool('search', 'budget report for March');
    expect(status.allowed).toBe(true);
    expect(status.warning).toBeUndefined();
  });

  test('recordToolCall increments count', () => {
    const sp = new Scratchpad('counting');
    sp.recordToolCall('search');
    sp.recordToolCall('search');
    sp.recordToolCall('pnl');
    const statuses = sp.getToolUsageStatus();
    const searchStatus = statuses.find((s) => s.toolName === 'search');
    expect(searchStatus!.callCount).toBe(2);
    const pnlStatus = statuses.find((s) => s.toolName === 'pnl');
    expect(pnlStatus!.callCount).toBe(1);
  });

  test('getToolResults returns formatted tool results', () => {
    const sp = new Scratchpad('results test');
    sp.addToolResult('spending_summary', { month: '2026-02' }, '{"total": 250}');
    const output = sp.getToolResults();
    expect(output).toContain('spending_summary');
    expect(output).toContain('month=2026-02');
    expect(output).toContain('total');
  });

  test('getToolResults returns empty string when no results', () => {
    const sp = new Scratchpad('empty results');
    const output = sp.getToolResults();
    expect(output).toBe('');
  });

  test('clearOldestToolResults keeps most recent', () => {
    const sp = new Scratchpad('clearing test');
    sp.addToolResult('tool_a', {}, '"result_a"');
    sp.addToolResult('tool_b', {}, '"result_b"');
    sp.addToolResult('tool_c', {}, '"result_c"');

    const cleared = sp.clearOldestToolResults(1); // Keep only 1
    expect(cleared).toBe(2);

    const output = sp.getToolResults();
    expect(output).toContain('tool_c');
    expect(output).toContain('cleared from context');
  });

  test('clearOldestToolResults returns 0 when nothing to clear', () => {
    const sp = new Scratchpad('nothing to clear');
    sp.addToolResult('only_one', {}, '"data"');
    const cleared = sp.clearOldestToolResults(5); // Keep 5 but only 1 exists
    expect(cleared).toBe(0);
  });

  test('hasExecutedSkill detects executed skills', () => {
    const sp = new Scratchpad('skill check');
    sp.addToolResult('skill', { skill: 'monthly-report' }, '"done"');
    expect(sp.hasExecutedSkill('monthly-report')).toBe(true);
    expect(sp.hasExecutedSkill('tax-summary')).toBe(false);
  });

  test('hasToolResults returns true after adding results', () => {
    const sp = new Scratchpad('has results');
    expect(sp.hasToolResults()).toBe(false);
    sp.addToolResult('test', {}, '"ok"');
    expect(sp.hasToolResults()).toBe(true);
  });

  test('getActiveToolResultCount tracks non-cleared results', () => {
    const sp = new Scratchpad('active count');
    sp.addToolResult('a', {}, '"1"');
    sp.addToolResult('b', {}, '"2"');
    expect(sp.getActiveToolResultCount()).toBe(2);

    sp.clearOldestToolResults(1);
    expect(sp.getActiveToolResultCount()).toBe(1);
  });

  test('formatToolUsageForPrompt returns null when no calls', () => {
    const sp = new Scratchpad('no calls');
    expect(sp.formatToolUsageForPrompt()).toBeNull();
  });

  test('formatToolUsageForPrompt includes usage info', () => {
    const sp = new Scratchpad('usage format');
    sp.recordToolCall('search');
    sp.recordToolCall('search');
    const output = sp.formatToolUsageForPrompt();
    expect(output).toContain('search');
    expect(output).toContain('2/3 calls');
  });

  test('getToolCallRecords returns all records', () => {
    const sp = new Scratchpad('records test');
    sp.addToolResult('search', { query: 'test' }, '{"found": true}');
    sp.addToolResult('pnl', { month: '2026-02' }, '{"net": 100}');
    const records = sp.getToolCallRecords();
    expect(records).toHaveLength(2);
    expect(records[0].tool).toBe('search');
    expect(records[1].tool).toBe('pnl');
  });
});
