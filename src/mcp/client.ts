import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { loadMcpConfig, type McpServerConfig } from './config.js';

interface McpClientEntry {
  client: Client;
  transport: StdioClientTransport;
}

const clients = new Map<string, McpClientEntry>();

/**
 * Initialize all MCP clients from ~/.openaccountant/mcp.json.
 * Spawns each server process, connects via stdio, and calls tools/list to verify.
 * Returns the list of server names that connected successfully.
 */
export async function initMcpClients(): Promise<string[]> {
  const config = loadMcpConfig();
  const serverNames = Object.keys(config.servers);

  if (serverNames.length === 0) return [];

  const connected: string[] = [];

  for (const [name, serverConfig] of Object.entries(config.servers)) {
    try {
      await connectServer(name, serverConfig);
      connected.push(name);
    } catch (err) {
      console.error(
        `[mcp] Failed to connect to "${name}": ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  return connected;
}

async function connectServer(name: string, config: McpServerConfig): Promise<void> {
  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args,
    env: config.env ? { ...process.env, ...config.env } as Record<string, string> : undefined,
  });

  const client = new Client({
    name: 'open-accountant',
    version: '0.1.0',
  });

  await client.connect(transport);

  // Verify connection by listing tools
  await client.listTools();

  clients.set(name, { client, transport });
}

/**
 * Get a connected MCP client by server name.
 */
export function getMcpClient(serverName: string): Client | undefined {
  return clients.get(serverName)?.client;
}

/**
 * Get all connected server names.
 */
export function getConnectedServers(): string[] {
  return Array.from(clients.keys());
}

/**
 * Close all MCP client connections and kill server processes.
 */
export async function closeMcpClients(): Promise<void> {
  for (const [name, entry] of clients) {
    try {
      await entry.client.close();
    } catch {
      // Ignore close errors during shutdown
    }
    clients.delete(name);
  }
}
