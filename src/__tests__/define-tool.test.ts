import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { defineTool } from '../tools/define-tool.js';
import type { ToolInvokeConfig } from '../model/types.js';

describe('defineTool argument validation guard', () => {
  test('malformed args are rejected before the tool function runs', async () => {
    let funcCalls = 0;
    const tool = defineTool({
      name: 'edit_transaction',
      description: 'Edit a transaction',
      schema: z.object({ id: z.number(), amount: z.number().optional() }),
      func: async () => {
        funcCalls++;
        return 'edited';
      },
    });

    const error = await tool.func({ id: 'abc', amount: 'not-a-number' } as any).then(() => null, (e: Error) => e);

    expect(funcCalls).toBe(0); // tool function never invoked
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("Invalid arguments for tool 'edit_transaction'");
    expect((error as Error).message).toContain('id'); // offending fields named
    expect((error as Error).message).toContain('amount');
  });

  test('missing required field is rejected with the field named', async () => {
    let funcCalls = 0;
    const tool = defineTool({
      name: 'delete_transaction',
      description: 'Delete a transaction',
      schema: z.object({ id: z.number() }),
      func: async () => {
        funcCalls++;
        return 'deleted';
      },
    });

    const error = await tool.func({} as any).then(() => null, (e: Error) => e);

    expect(funcCalls).toBe(0);
    expect((error as Error).message).toContain("Invalid arguments for tool 'delete_transaction'");
    expect((error as Error).message).toContain('id');
  });

  test('valid args pass through to func as the original object (no stripping)', async () => {
    let receivedArgs: any;
    const tool = defineTool({
      name: 'edit_transaction',
      description: 'Edit a transaction',
      schema: z.object({ id: z.number() }),
      func: async (args) => {
        receivedArgs = args;
        return 'edited';
      },
    });

    const original = { id: 1, extra: 'keep-me', notes: undefined };
    const result = await tool.func(original as any);

    expect(result).toBe('edited');
    expect(receivedArgs).toBe(original); // same reference — not a re-parsed copy
    expect(receivedArgs.extra).toBe('keep-me'); // unknown keys preserved
  });

  test('optional-args objects from programmatic callers pass through unchanged', async () => {
    let receivedArgs: any;
    const tool = defineTool({
      name: 'monarch_import',
      description: 'Import from Monarch',
      schema: z.object({
        apiKey: z.string().optional(),
        includeHistory: z.boolean().optional(),
      }),
      func: async (args) => {
        receivedArgs = args;
        return 'imported';
      },
    });

    const original = {};
    const result = await tool.func(original);

    expect(result).toBe('imported');
    expect(receivedArgs).toBe(original);
  });

  test('config argument is forwarded to the tool function', async () => {
    let receivedConfig: ToolInvokeConfig | undefined;
    const tool = defineTool({
      name: 'search',
      description: 'Search',
      schema: z.object({ q: z.string() }),
      func: async (_args, config) => {
        receivedConfig = config;
        return 'results';
      },
    });

    const config: ToolInvokeConfig = { metadata: { onProgress: () => {} }, model: 'gpt-5.2' };
    await tool.func({ q: 'hello' }, config);

    expect(receivedConfig).toBe(config);
  });
});