import { z } from 'zod';
import type { ToolDef, ToolInvokeConfig } from '../model/types.js';

/**
 * Format zod issues as a compact field-first list, e.g.
 * "id: Invalid input: expected number, received string; amount: Required".
 */
function formatZodIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const field = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      return `${field}: ${issue.message}`;
    })
    .join('; ');
}

/**
 * Simple helper to define a tool — replaces `new DynamicStructuredTool()`.
 *
 * Every ToolDef in the repo is created here, so this is the single choke point
 * for argument validation: each invocation parses its arguments against the
 * tool's own zod schema before the tool function runs. That covers the agent
 * executor, orchestration chain/team members (which call tools directly), and
 * programmatic callers — a malformed tool call from the model is rejected with
 * a field-naming error and never reaches the tool function.
 *
 * On success the ORIGINAL arguments object is passed through unchanged
 * (validate-only, not `parsed.data`) so valid callers see zero behavior
 * change: no key stripping, no default injection, no coercion surprises.
 */
export function defineTool<T extends z.ZodType>(config: {
  name: string;
  description: string;
  schema: T;
  func: (args: z.infer<T>, config?: ToolInvokeConfig) => Promise<string>;
}): ToolDef<T> {
  const { name, schema, func } = config;

  const guardedFunc = async (args: z.infer<T>, toolConfig?: ToolInvokeConfig): Promise<string> => {
    const parsed = schema.safeParse(args);
    if (!parsed.success) {
      throw new Error(`Invalid arguments for tool '${name}': ${formatZodIssues(parsed.error)}`);
    }
    return func(args, toolConfig);
  };

  return { ...config, func: guardedFunc };
}