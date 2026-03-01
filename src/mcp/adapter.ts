import { z } from 'zod';
import { defineTool } from '../tools/define-tool.js';
import { formatToolResult } from '../tools/types.js';
import { getMcpClient, getConnectedServers } from './client.js';
import type { ToolDef } from '../model/types.js';

/**
 * Convert a JSON Schema type definition into a Zod schema.
 * Handles the common types that MCP tools use.
 */
function jsonSchemaToZod(schema: Record<string, unknown>): z.ZodType {
  if (!schema || typeof schema !== 'object') return z.unknown();

  const type = schema.type as string | undefined;

  // Handle enum — accept as string, MCP server validates
  if (schema.enum && Array.isArray(schema.enum)) {
    return z.string();
  }

  switch (type) {
    case 'string':
      return z.string();
    case 'number':
    case 'integer':
      return z.number();
    case 'boolean':
      return z.boolean();
    case 'array': {
      const items = schema.items as Record<string, unknown> | undefined;
      return z.array(items ? jsonSchemaToZod(items) : z.unknown());
    }
    case 'object': {
      const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
      const required = (schema.required as string[]) ?? [];

      if (!properties) return z.record(z.string(), z.unknown());

      const shape: Record<string, z.ZodType> = {};
      for (const [key, propSchema] of Object.entries(properties)) {
        let field = jsonSchemaToZod(propSchema);
        const desc = propSchema.description as string | undefined;
        if (desc && 'describe' in field) {
          field = (field as z.ZodType & { describe: (d: string) => z.ZodType }).describe(desc);
        }
        if (!required.includes(key)) {
          field = field.optional();
        }
        shape[key] = field;
      }
      return z.object(shape);
    }
    default:
      return z.unknown();
  }
}

// Cached MCP tools — populated once at startup, read synchronously by the registry
let cachedMcpTools: ToolDef[] = [];

/**
 * Load and cache MCP tools. Call once at startup after initMcpClients().
 */
export async function loadMcpTools(): Promise<void> {
  cachedMcpTools = await getMcpTools();
}

/**
 * Get the cached MCP tools (synchronous, for use in the tool registry).
 */
export function getCachedMcpTools(): ToolDef[] {
  return cachedMcpTools;
}

/**
 * Get all MCP server tools as Wilson ToolDef[] instances.
 * Each MCP tool is wrapped in defineTool() so it integrates seamlessly
 * with the existing tool registry and agent executor.
 */
async function getMcpTools(): Promise<ToolDef[]> {
  const tools: ToolDef[] = [];

  for (const serverName of getConnectedServers()) {
    const client = getMcpClient(serverName);
    if (!client) continue;

    let toolList: { tools: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }> };
    try {
      toolList = await client.listTools();
    } catch {
      continue;
    }

    for (const mcpTool of toolList.tools) {
      const toolName = `mcp_${serverName}_${mcpTool.name}`;
      const description = mcpTool.description ?? `MCP tool from ${serverName}`;
      const inputSchema = (mcpTool.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} };
      const zodSchema = jsonSchemaToZod(inputSchema);

      const tool = defineTool({
        name: toolName,
        description,
        schema: zodSchema,
        func: async (args: unknown) => {
          const mcpClient = getMcpClient(serverName);
          if (!mcpClient) {
            return formatToolResult({ error: `MCP server "${serverName}" is not connected` });
          }

          try {
            const result = await mcpClient.callTool({
              name: mcpTool.name,
              arguments: args as Record<string, unknown>,
            });

            // MCP tool results have a content array
            const content = result.content as Array<{ type: string; text?: string }> | undefined;
            if (content && Array.isArray(content)) {
              const texts = content
                .filter((c) => c.type === 'text' && c.text)
                .map((c) => c.text!);
              return formatToolResult(texts.length === 1 ? texts[0] : texts);
            }

            return formatToolResult(result);
          } catch (err) {
            return formatToolResult({
              error: `MCP tool "${mcpTool.name}" failed: ${err instanceof Error ? err.message : String(err)}`,
            });
          }
        },
      });

      tools.push(tool);
    }
  }

  return tools;
}
