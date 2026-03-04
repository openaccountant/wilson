import { describe, expect, test, beforeEach } from 'bun:test';
import { AgentToolExecutor } from '../agent/tool-executor.js';
import { createRunContext } from '../agent/run-context.js';
import type { LlmResponse, ToolDef } from '../model/types.js';
import type { ApprovalDecision } from '../agent/types.js';
import { ensureTestProfile, mockTool, collectEvents } from './helpers.js';

describe('AgentToolExecutor', () => {
  beforeEach(() => {
    ensureTestProfile();
  });

  function makeLlmResponse(toolCalls: LlmResponse['toolCalls']): LlmResponse {
    return { content: '', toolCalls };
  }

  test('single tool execution emits start and end events', async () => {
    const tool = mockTool('test_tool', async () => 'result-data');
    const toolMap = new Map<string, ToolDef>([['test_tool', tool]]);
    const executor = new AgentToolExecutor(toolMap);
    const ctx = createRunContext('test query');

    const response = makeLlmResponse([
      { id: 'tc1', name: 'test_tool', args: { q: 'hello' } },
    ]);

    const events = await collectEvents(executor.executeAll(response, ctx));
    const types = events.map((e) => e.type);
    expect(types).toContain('tool_start');
    expect(types).toContain('tool_end');

    const endEvent = events.find((e) => e.type === 'tool_end')!;
    expect(endEvent.tool).toBe('test_tool');
    expect((endEvent as any).result).toBe('result-data');
  });

  test('tool error emits start and error events', async () => {
    const tool = mockTool('bad_tool', async () => {
      throw new Error('tool failed');
    });
    const toolMap = new Map<string, ToolDef>([['bad_tool', tool]]);
    const executor = new AgentToolExecutor(toolMap);
    const ctx = createRunContext('test query');

    const response = makeLlmResponse([
      { id: 'tc1', name: 'bad_tool', args: {} },
    ]);

    const events = await collectEvents(executor.executeAll(response, ctx));
    const types = events.map((e) => e.type);
    expect(types).toContain('tool_start');
    expect(types).toContain('tool_error');

    const errorEvent = events.find((e) => e.type === 'tool_error')!;
    expect((errorEvent as any).error).toBe('tool failed');
  });

  test('unknown tool emits error', async () => {
    const toolMap = new Map<string, ToolDef>();
    const executor = new AgentToolExecutor(toolMap);
    const ctx = createRunContext('test query');

    const response = makeLlmResponse([
      { id: 'tc1', name: 'nonexistent', args: {} },
    ]);

    const events = await collectEvents(executor.executeAll(response, ctx));
    const errorEvent = events.find((e) => e.type === 'tool_error');
    expect(errorEvent).toBeTruthy();
    expect((errorEvent as any).error).toContain("'nonexistent' not found");
  });

  test('skill dedup skips already-executed skills', async () => {
    const tool = mockTool('skill', async () => 'skill instructions');
    const toolMap = new Map<string, ToolDef>([['skill', tool]]);
    const executor = new AgentToolExecutor(toolMap);
    const ctx = createRunContext('test query');

    // Simulate first skill execution by adding a tool result to scratchpad
    ctx.scratchpad.addToolResult('skill', { skill: 'budget-audit' }, 'instructions');

    const response = makeLlmResponse([
      { id: 'tc1', name: 'skill', args: { skill: 'budget-audit' } },
    ]);

    const events = await collectEvents(executor.executeAll(response, ctx));
    // The deduped skill should produce no events
    expect(events).toHaveLength(0);
  });

  test('approval flow - deny stops execution', async () => {
    const tool = mockTool('categorize', async () => 'categorized');
    const toolMap = new Map<string, ToolDef>([['categorize', tool]]);
    const requestApproval = async (): Promise<ApprovalDecision> => 'deny';
    const executor = new AgentToolExecutor(toolMap, undefined, requestApproval);
    const ctx = createRunContext('test query');

    const response = makeLlmResponse([
      { id: 'tc1', name: 'categorize', args: {} },
    ]);

    const events = await collectEvents(executor.executeAll(response, ctx));
    const types = events.map((e) => e.type);
    expect(types).toContain('tool_approval');
    expect(types).toContain('tool_denied');
    // Should not have tool_start or tool_end
    expect(types).not.toContain('tool_end');
  });

  test('approval flow - allow-once permits execution', async () => {
    const tool = mockTool('categorize', async () => 'done');
    const toolMap = new Map<string, ToolDef>([['categorize', tool]]);
    const requestApproval = async (): Promise<ApprovalDecision> => 'allow-once';
    const executor = new AgentToolExecutor(toolMap, undefined, requestApproval);
    const ctx = createRunContext('test query');

    const response = makeLlmResponse([
      { id: 'tc1', name: 'categorize', args: {} },
    ]);

    const events = await collectEvents(executor.executeAll(response, ctx));
    const types = events.map((e) => e.type);
    expect(types).toContain('tool_approval');
    expect(types).toContain('tool_start');
    expect(types).toContain('tool_end');
  });

  test('approval flow - allow-session adds to session set', async () => {
    const tool = mockTool('categorize', async () => 'done');
    const toolMap = new Map<string, ToolDef>([['categorize', tool]]);
    const sessionApproved = new Set<string>();
    const requestApproval = async (): Promise<ApprovalDecision> => 'allow-session';
    const executor = new AgentToolExecutor(toolMap, undefined, requestApproval, sessionApproved);
    const ctx = createRunContext('test query');

    const response = makeLlmResponse([
      { id: 'tc1', name: 'categorize', args: {} },
    ]);

    await collectEvents(executor.executeAll(response, ctx));
    expect(sessionApproved.has('categorize')).toBe(true);
  });

  test('tool result is stringified if not a string', async () => {
    const tool = mockTool('json_tool', async () => JSON.stringify({ total: 500 }));
    const toolMap = new Map<string, ToolDef>([['json_tool', tool]]);
    const executor = new AgentToolExecutor(toolMap);
    const ctx = createRunContext('test query');

    const response = makeLlmResponse([
      { id: 'tc1', name: 'json_tool', args: {} },
    ]);

    const events = await collectEvents(executor.executeAll(response, ctx));
    const endEvent = events.find((e) => e.type === 'tool_end')!;
    expect((endEvent as any).result).toBe('{"total":500}');
  });

  test('multiple tool calls execute sequentially', async () => {
    const callOrder: string[] = [];
    const tool1 = mockTool('tool_a', async () => { callOrder.push('a'); return 'a-result'; });
    const tool2 = mockTool('tool_b', async () => { callOrder.push('b'); return 'b-result'; });
    const toolMap = new Map<string, ToolDef>([['tool_a', tool1], ['tool_b', tool2]]);
    const executor = new AgentToolExecutor(toolMap);
    const ctx = createRunContext('test query');

    const response = makeLlmResponse([
      { id: 'tc1', name: 'tool_a', args: {} },
      { id: 'tc2', name: 'tool_b', args: {} },
    ]);

    const events = await collectEvents(executor.executeAll(response, ctx));
    expect(callOrder).toEqual(['a', 'b']);
    const endEvents = events.filter((e) => e.type === 'tool_end');
    expect(endEvents).toHaveLength(2);
  });
});
