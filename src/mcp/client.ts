import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { loadMcpConfig, validateRemoteUrl, type McpServerConfig, type McpTransportKind } from './config.js';
import type { FetchLike, Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

interface McpClientEntry {
  client: Client;
  transport: Transport;
  kind: McpTransportKind;
}

const clients = new Map<string, McpClientEntry>();

/**
 * Initialize all MCP clients from ~/.openaccountant/mcp.json.
 * Spawns each stdio server process or connects to each remote server (Streamable
 * HTTP or SSE), and calls tools/list to verify.
 * Returns the list of server names that connected successfully.
 */
export async function initMcpClients(): Promise<string[]> {
  const config = loadMcpConfig();
  const serverNames = Object.keys(config.servers);

  if (serverNames.length === 0) return [];

  const connected: string[] = [];

  for (const [name, serverConfig] of Object.entries(config.servers)) {
    try {
      const entry = await connectServer(name, serverConfig);
      clients.set(name, entry);
      connected.push(name);
    } catch (err) {
      console.error(
        `[mcp] Failed to connect to "${name}": ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  return connected;
}

/** The part of the SDK client the connect path uses (so tests can pass a fake). */
export interface ConnectableClient {
  connect(transport: Transport): Promise<void>;
  listTools(): Promise<unknown>;
  close(): Promise<void>;
}

/** Factories for the connect path; tests replace them, production uses the SDK. */
export interface ConnectDeps<C extends ConnectableClient = Client> {
  createClient: () => C;
  createTransport: (kind: McpTransportKind, config: McpServerConfig) => Transport;
}

/** Most redirects a remote MCP request follows (same origin only). */
export const REMOTE_MAX_REDIRECTS = 5;

/**
 * The fetch a remote MCP transport uses. Redirects are handled here (`redirect: 'manual'`), not by the default
 * fetch: one is followed only when it stays on the configured server's origin (same scheme, host and port) and the
 * new URL passes `validateRemoteUrl`. A redirect elsewhere (plain http, a loopback or private address, any other
 * host) is refused before anything is sent to it, so the server cannot steer requests and their payloads past the
 * egress guard. At most REMOTE_MAX_REDIRECTS hops.
 */
export function createRemoteFetch(configUrl: string, baseFetch: FetchLike = fetch): FetchLike {
  const origin = new URL(configUrl).origin;
  return async (url, init) => {
    let current = new URL(String(url));
    let currentInit: RequestInit = { ...init, redirect: 'manual' };
    for (let hop = 0; ; hop++) {
      const response = await baseFetch(current, currentInit);
      const isRedirect = response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400 && response.status !== 304);
      if (!isRedirect) return response;
      await response.body?.cancel().catch(() => {});
      const location = response.headers.get('location');
      if (!location || response.type === 'opaqueredirect') {
        throw new Error(`MCP server ${origin} sent a redirect that cannot be checked; refused`);
      }
      if (hop >= REMOTE_MAX_REDIRECTS) throw new Error(`MCP server ${origin}: too many redirects; refused`);
      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        throw new Error(`MCP server ${origin} sent an invalid redirect; refused`);
      }
      if (next.origin !== origin || validateRemoteUrl(next.href) !== null) {
        throw new Error(`MCP server ${origin} redirected to another origin (${next.origin}); refused`);
      }
      // 303, and 301 / 302 after a POST, continue as a GET without a body (as fetch would); 307 / 308 keep both.
      const method = (currentInit.method ?? 'GET').toUpperCase();
      if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')) {
        const { body: _body, ...rest } = currentInit;
        currentInit = { ...rest, method: 'GET' };
      }
      current = next;
    }
  };
}

/** The SDK transport for a server, with `createRemoteFetch` on every remote one. */
export function createSdkTransport(kind: McpTransportKind, config: McpServerConfig): Transport {
  switch (kind) {
    case 'http':
      return new StreamableHTTPClientTransport(new URL(config.url!), { fetch: createRemoteFetch(config.url!) });
    case 'sse':
      // The SSE stream (EventSource) and the POSTs both go through `fetch`; eventSourceInit is not set, so the
      // SDK's stream fetch falls back to it.
      return new SSEClientTransport(new URL(config.url!), { fetch: createRemoteFetch(config.url!) });
    case 'stdio':
      return new StdioClientTransport({
        command: config.command!,
        args: config.args,
        env: config.env ? { ...process.env, ...config.env } as Record<string, string> : undefined,
      });
  }
}

const sdkDeps: ConnectDeps<Client> = {
  createClient: () => new Client({ name: 'open-accountant', version: '0.1.0' }),
  createTransport: createSdkTransport,
};

/**
 * The transports to try for a server, in order.
 * - explicit 'http' / 'sse' / 'stdio': that one only;
 * - a `command` (no transport): stdio;
 * - a bare `url` (no transport): Streamable HTTP, then SSE as fallback for
 *   servers that only speak the older protocol.
 */
export function transportPlan(config: McpServerConfig): McpTransportKind[] {
  if (config.transport) return [config.transport];
  if (config.command) return ['stdio'];
  if (config.url) return ['http', 'sse'];
  return ['stdio'];
}

/**
 * Connect to one server. With a fallback plan, a failed first connect is
 * closed and the next transport gets a fresh client (an SDK client that
 * failed to initialize is not reused). Throws the last error when every
 * transport fails.
 */
export async function connectServer<C extends ConnectableClient = Client>(
  name: string,
  config: McpServerConfig,
  deps: ConnectDeps<C> = sdkDeps as unknown as ConnectDeps<C>,
): Promise<{ client: C; transport: Transport; kind: McpTransportKind }> {
  const plan = transportPlan(config);

  if (plan[0] === 'stdio') {
    if (!config.command) throw new Error(`Stdio server "${name}" requires a "command" field`);
  } else {
    const urlError = validateRemoteUrl(config.url);
    if (urlError) throw new Error(`Remote server "${name}": ${urlError}`);
  }

  let lastError: unknown;
  for (const kind of plan) {
    const client = deps.createClient();
    const transport = deps.createTransport(kind, config);
    try {
      await client.connect(transport);
      // Verify connection by listing tools
      await client.listTools();
      return { client, transport, kind };
    } catch (err) {
      lastError = err;
      try {
        await client.close();
      } catch {
        // A transport that never opened may refuse to close; nothing to clean up.
      }
    }
  }
  if (plan.length > 1) {
    throw new Error(
      `could not connect over ${plan.join(' or ')}: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    );
  }
  throw lastError;
}

/**
 * Get a connected MCP client by server name.
 */
export function getMcpClient(serverName: string): Client | undefined {
  return clients.get(serverName)?.client;
}

/** The transport a connected server ended up on (after any fallback). */
export function getServerTransportKind(serverName: string): McpTransportKind | undefined {
  return clients.get(serverName)?.kind;
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
