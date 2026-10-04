import { describe, expect, test } from 'bun:test';
import { AgentRunnerController } from '../controllers/index.js';
import { InMemoryChatHistory } from '../utils/in-memory-chat-history.js';
import type { ApprovalDecision, ToolApprovalRequest } from '../agent/types.js';

/**
 * The TUI approval prompt (src/cli.ts renderSelectionOverlay) binds itself to
 * the exact request it was built for, like the dashboard chat card: it
 * captures the runner's pendingApprovalId when the prompt is built and
 * answers with it. A prompt left over from an earlier request (answered or
 * cancelled meanwhile) must not answer the request that replaced it.
 */

function makeRunner() {
  const runner = new AgentRunnerController({}, new InMemoryChatHistory());
  // The runner raises requests from inside an agent run; drive that path directly.
  const ask = (req: ToolApprovalRequest): Promise<ApprovalDecision> =>
    (runner as unknown as { requestToolApproval: (r: ToolApprovalRequest) => Promise<ApprovalDecision> }).requestToolApproval(req);
  return { runner, ask };
}

const editReq: ToolApprovalRequest = { tool: 'edit_transaction', args: { id: 1 }, session: { key: 'edit_transaction' } };
const deleteReq: ToolApprovalRequest = { tool: 'delete_transaction', args: { id: 1 }, session: { key: 'delete_transaction' } };

describe('TUI approval prompt binding', () => {
  test('no pending request: nothing to bind', () => {
    const { runner } = makeRunner();
    expect(runner.bindPendingApproval()).toBeNull();
  });

  test('the prompt answers the request it was built for', async () => {
    const { runner, ask } = makeRunner();
    const decision = ask(editReq);
    const prompt = runner.bindPendingApproval()!;
    expect(prompt.request).toBe(editReq);
    expect(prompt.requestId).toBe(runner.pendingApprovalId!);
    expect(prompt.respond('allow-once')).toBe(true);
    expect(await decision).toBe('allow-once');
    expect(runner.pendingApproval).toBeNull();
  });

  test('a stale prompt cannot answer the request that replaced its own', async () => {
    const { runner, ask } = makeRunner();
    const first = ask(editReq);
    const stalePrompt = runner.bindPendingApproval()!;

    // The first request is cancelled (esc / ctrl-c / deadline) and the agent
    // raises a different one before the old prompt's keypress lands.
    runner.cancelExecution();
    expect(await first).toBe('deny');
    const second = ask(deleteReq);
    expect(runner.pendingApproval).toBe(deleteReq);

    expect(stalePrompt.respond('allow-once')).toBe(false);
    expect(runner.pendingApproval).toBe(deleteReq); // still waiting, unanswered

    const fresh = runner.bindPendingApproval()!;
    expect(fresh.request).toBe(deleteReq);
    expect(fresh.respond('deny')).toBe(true);
    expect(await second).toBe('deny');
  });

  test('answering twice: the second answer is refused', async () => {
    const { runner, ask } = makeRunner();
    const decision = ask(editReq);
    const prompt = runner.bindPendingApproval()!;
    expect(prompt.respond('deny')).toBe(true);
    expect(prompt.respond('allow-once')).toBe(false);
    expect(await decision).toBe('deny');
  });
});
