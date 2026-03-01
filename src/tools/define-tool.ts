import { z } from 'zod';
import type { ToolDef, ToolInvokeConfig } from '../model/types.js';

/**
 * Simple helper to define a tool — replaces `new DynamicStructuredTool()`.
 * Returns the config object directly (no class wrapper needed).
 */
export function defineTool<T extends z.ZodType>(config: {
  name: string;
  description: string;
  schema: T;
  func: (args: z.infer<T>, config?: ToolInvokeConfig) => Promise<string>;
}): ToolDef<T> {
  return config;
}
