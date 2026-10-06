import { readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { logger } from '../utils/logger.js';

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
  /**
   * Tools of this server (by the server's own tool name) that the USER
   * declares read-only: only these run without an approval card. Every other
   * tool of the server is treated as mutating and needs approval for each
   * call. The server's own readOnlyHint/destructiveHint annotations are never
   * trusted for this (#152). Must be an array of strings; anything else is
   * dropped with a warning, leaving every tool of the server mutating.
   */
  readOnlyTools?: string[];
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
        return { servers: validateServers(servers as Record<string, McpServerConfig>) };
      }
    }
    return { servers: {} };
  } catch {
    return { servers: {} };
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

/**
 * Validate the fields that decide what runs without approval. An invalid
 * `readOnlyTools` is removed (fail closed: no tool of that server becomes
 * read-only) with a warning; everything else passes through unchanged.
 */
function validateServers(servers: Record<string, McpServerConfig>): Record<string, McpServerConfig> {
  for (const [name, server] of Object.entries(servers)) {
    if (!server || typeof server !== 'object' || !('readOnlyTools' in server)) continue;
    if (!isStringArray(server.readOnlyTools)) {
      logger.warn(
        `[mcp] mcp.json: "readOnlyTools" for server "${name}" must be an array of tool names (strings); ignoring it — every tool of "${name}" will need approval`,
        { server: name },
      );
      const { readOnlyTools: _dropped, ...rest } = server;
      servers[name] = rest;
    }
  }
  return servers;
}
