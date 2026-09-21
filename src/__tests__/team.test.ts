import { describe, expect, test, beforeEach, afterEach, spyOn } from 'bun:test';
import { runTeam } from '../orchestration/team.js';
import type { TeamDef } from '../orchestration/types.js';
import type { LlmResult } from '../model/llm.js';
import * as llmModule from '../model/llm.js';
import { LlmValidationError } from '../model/structured-output.js';

const team: TeamDef = {
  name: 'test-team',
  description: 'A team used by tests',
  dispatcher: { systemPrompt: 'You dispatch subtasks.' },
  members: [{ id: 'analyst', systemPrompt: 'You analyze spending.' }],
};

describe('runTeam', () => {
  let llmSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    llmSpy = spyOn(llmModule, 'callLlm');
  });

  afterEach(() => {
    llmSpy.mockRestore();
  });

  test('dispatch validation rejection degrades to the dispatcher direct answer', async () => {
    llmSpy.mockRejectedValue(
      new LlmValidationError(
        'LLM structured output failed schema validation after one repair attempt: assignments: Invalid input: expected array, received string',
        ['assignments: Invalid input: expected array, received string'],
        { content: 'Answering directly: total spending was $42 last month.', toolCalls: [] },
      ),
    );

    const result = await runTeam(team, 'How much did we spend?');
    expect(result).toBe('Answering directly: total spending was $42 last month.');
    expect(llmSpy).toHaveBeenCalledTimes(1); // no member runs, no synthesis call
  });

  test('empty direct answer on rejection falls back to the no-subtasks message', async () => {
    llmSpy.mockRejectedValue(
      new LlmValidationError('LLM structured output failed schema validation', ['assignments: expected array'], {
        content: '   ',
        toolCalls: [],
      }),
    );

    const result = await runTeam(team, 'anything');
    expect(result).toBe('No subtasks were assigned.');
  });

  test('non-validation dispatch errors still propagate', async () => {
    llmSpy.mockRejectedValue(new Error('network unreachable'));

    await expect(runTeam(team, 'query')).rejects.toThrow('network unreachable');
  });

  test('happy path: valid dispatch assignments run members then synthesize', async () => {
    const responses: LlmResult[] = [
      {
        response: {
          content: 'Dispatching one subtask.',
          toolCalls: [],
          structured: { assignments: [{ memberId: 'analyst', subtask: 'Summarize spending' }] },
        },
      },
      { response: { content: 'Member findings: spent $42.', toolCalls: [] } },
      { response: { content: 'Final synthesized answer.', toolCalls: [] } },
    ];
    let call = 0;
    llmSpy.mockImplementation(async () => {
      const res = responses[Math.min(call, responses.length - 1)];
      call++;
      return res;
    });

    const completed: Array<[string, string]> = [];
    const result = await runTeam(team, 'Analyze my spending', {
      onMemberComplete: (memberId, output) => completed.push([memberId, output]),
    });

    expect(result).toBe('Final synthesized answer.');
    expect(call).toBe(3); // dispatch + member + synthesis
    expect(completed).toEqual([['analyst', 'Member findings: spent $42.']]);
  });
});