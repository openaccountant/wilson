import { readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

/**
 * Configuration for a single MCP server.
 * Supports stdio (command + args) and SSE (url) transports.
 */
export interface McpServerConfig {
  /** Transport type. Defaults to 'stdio' when command is set, 'sse' when url is set. */
  transport?: 'stdio' | 'sse';
  /** Command to spawn (stdio transport). */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** Server URL (SSE transport). */
  url?: string;
}

/**
 * Top-level MCP configuration (loaded from ~/.openaccountant/mcp.json).
 */
export interface McpConfig {
  servers: Record<string, McpServerConfig>;
}

const CONFIG_PATH = join(homedir(), '.openaccountant', 'mcp.json');

/**
 * Load and parse the MCP config file.
 * Returns an empty config if the file is missing or invalid.
 */
export function loadMcpConfig(): McpConfig {
  let raw: string;
  try {
    raw = readFileSync(CONFIG_PATH, 'utf-8');
  } catch {
    return { servers: {} };
  }

  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      // Support both "servers" and "mcpServers" keys
      const servers = parsed.servers ?? parsed.mcpServers;
      if (servers && typeof servers === 'object') {
        return { servers } as McpConfig;
      }
    }
    return { servers: {} };
  } catch {
    return { servers: {} };
  }
}
