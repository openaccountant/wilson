import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';
import { logger } from '../utils/logger.js';

/** Transports an MCP server config can name. */
export type McpTransportKind = 'stdio' | 'http' | 'sse';

/**
 * Configuration for a single MCP server.
 * Supports stdio (command + args), Streamable HTTP and SSE (url) transports.
 */
export interface McpServerConfig {
  /**
   * Transport type. Defaults to 'stdio' when command is set. A bare `url`
   * with no transport tries Streamable HTTP first and falls back to SSE when
   * the first connect fails; 'http' and 'sse' pin one transport.
   */
  transport?: McpTransportKind;
  /** Command to spawn (stdio transport). */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** Server URL (http / SSE transport). https is required except for localhost / 127.0.0.1 / [::1]. */
  url?: string;
  /**
   * What to do when an outbound call to a REMOTE server carries personal
   * financial data (amounts, account numbers, tax ids, emails, phones):
   * 'redact' (default) replaces it and sends the call; 'block' refuses the
   * call. Ignored for stdio servers.
   */
  egress?: 'redact' | 'block';
  /**
   * Tools of this server (by the server's own tool name) that the USER
   * declares read-only: only these run without an approval card. Every other
   * tool of the server is treated as mutating and needs approval for each
   * call. The server's own readOnlyHint/destructiveHint annotations are never
   * trusted for this (#152). Must be an array of strings; anything else is
   * dropped with a warning, leaving every tool of the server mutating.
   */
  readOnlyTools?: string[];
  /**
   * Tools of this server (by the server's own tool name) that Wilson never
   * offers to the model: they are left out of the tool registry entirely, so
   * they can't be called. A preset can ship a default list (the
   * openaccountants preset hides `compute`, so calculations on the user's
   * own numbers stay local); the user opts a tool back in by removing it
   * from this list in mcp.json. Hidden wins over `readOnlyTools`. Must be an
   * array of strings; anything else drops the whole server with a warning
   * (fail closed: a broken list never exposes a tool meant to stay hidden).
   */
  hiddenTools?: string[];
}

/**
 * Top-level MCP configuration (loaded from ~/.openaccountant/mcp.json).
 */
export interface McpConfig {
  servers: Record<string, McpServerConfig>;
}

export const MCP_CONFIG_PATH = join(homedir(), '.openaccountant', 'mcp.json');

/**
 * Load and parse the MCP config file.
 * Returns an empty config if the file is missing or invalid.
 */
export function loadMcpConfig(): McpConfig {
  let raw: string;
  try {
    raw = readFileSync(MCP_CONFIG_PATH, 'utf-8');
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

/**
 * True when calls to this server leave the machine (http / SSE transport).
 * Mirrors the transport choice in ./client.ts: an explicit transport wins,
 * otherwise a `command` means stdio and a bare `url` means remote.
 */
export function isRemoteServer(config: McpServerConfig | undefined): boolean {
  if (!config) return false;
  if (config.transport === 'http' || config.transport === 'sse') return true;
  if (config.transport === 'stdio') return false;
  return !config.command && typeof config.url === 'string';
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Check a remote server URL: it must parse, and use https unless it points
 * at this machine (http://localhost, 127.0.0.1, [::1]). Returns an error
 * message, or null when the URL is acceptable.
 */
export function validateRemoteUrl(url: unknown): string | null {
  if (typeof url !== 'string' || url.trim() === '') return 'a "url" is required';
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return `"${url}" is not a valid URL`;
  }
  if (parsed.protocol === 'https:') return null;
  if (parsed.protocol === 'http:' && LOOPBACK_HOSTS.has(parsed.hostname)) return null;
  if (parsed.protocol === 'http:') return `"${url}" must use https (plain http is only allowed for localhost / 127.0.0.1)`;
  return `"${url}" must be an https URL`;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

const TRANSPORTS: ReadonlySet<string> = new Set<McpTransportKind>(['stdio', 'http', 'sse']);

/**
 * Validate the fields that decide what runs without approval and where data
 * goes:
 * - an invalid `readOnlyTools` is removed (fail closed: no tool of that
 *   server becomes read-only) with a warning;
 * - a server with an unknown `transport`, or a remote (http / SSE) server
 *   whose URL is missing, malformed or plain http to a non-local host, is
 *   dropped with a warning;
 * - an invalid `egress` is removed (the default, 'redact', applies);
 * - a server with an invalid `hiddenTools` is dropped with a warning (fail
 *   closed: a tool meant to stay hidden is never exposed by a typo).
 * Everything else passes through unchanged.
 */
export function validateServers(servers: Record<string, McpServerConfig>): Record<string, McpServerConfig> {
  for (const [name, original] of Object.entries(servers)) {
    if (!original || typeof original !== 'object') continue;
    let server = original;

    if (server.transport !== undefined && !TRANSPORTS.has(server.transport as string)) {
      logger.warn(
        `[mcp] mcp.json: server "${name}" has unknown transport ${JSON.stringify(server.transport)} (expected "stdio", "http" or "sse"); skipping it`,
        { server: name },
      );
      delete servers[name];
      continue;
    }

    if (isRemoteServer(server)) {
      const urlError = validateRemoteUrl(server.url);
      if (urlError) {
        logger.warn(`[mcp] mcp.json: server "${name}": ${urlError}; skipping it`, { server: name });
        delete servers[name];
        continue;
      }
    }

    if ('hiddenTools' in server && !isStringArray(server.hiddenTools)) {
      logger.warn(
        `[mcp] mcp.json: "hiddenTools" for server "${name}" must be an array of tool names (strings); skipping the server`,
        { server: name },
      );
      delete servers[name];
      continue;
    }

    if ('egress' in server && server.egress !== 'redact' && server.egress !== 'block') {
      logger.warn(
        `[mcp] mcp.json: "egress" for server "${name}" must be "redact" or "block"; using "redact"`,
        { server: name },
      );
      const { egress: _dropped, ...rest } = server;
      server = rest;
    }

    if ('readOnlyTools' in server && !isStringArray(server.readOnlyTools)) {
      logger.warn(
        `[mcp] mcp.json: "readOnlyTools" for server "${name}" must be an array of tool names (strings); ignoring it — every tool of "${name}" will need approval`,
        { server: name },
      );
      const { readOnlyTools: _dropped, ...rest } = server;
      server = rest;
    }

    if (server !== original) servers[name] = server;
  }
  return servers;
}

// ── Editing mcp.json (/mcp add | remove) ─────────────────────────────────────

/** A known remote server `/mcp add <preset>` can write without the user typing a URL. */
export interface McpServerPreset {
  config: McpServerConfig;
  /** One line shown after adding it. */
  notice: string;
}

export const MCP_SERVER_PRESETS: Readonly<Record<string, McpServerPreset>> = {
  openaccountants: {
    config: {
      transport: 'http',
      url: 'https://www.openaccountants.com/api/mcp',
      // Lookups of public tax knowledge (v1.4: get_skill takes `sections`; there is no
      // separate list or sections tool). Each still asks for approval past a short lookup
      // (see remoteCallMutates in ./adapter.ts). Tools that send the user's own details
      // (validate_vat_number, check_audit_exemption, share_with_openaccountants,
      // submit_feedback, ...) are deliberately NOT listed: every call to them needs approval.
      readOnlyTools: [
        'start',
        'search_skills',
        'get_skill',
        'search_rules',
        'get_deadlines',
        'list_jurisdictions',
        'list_verifiers',
      ],
      // `compute` would run calculations on the user's own numbers remotely; those stay
      // local. It is not offered to the model unless the user removes it from this list.
      hiddenTools: ['compute'],
    },
    notice:
      'Tax-knowledge queries go to a third-party service (openaccountants.com). Wilson tries to replace amounts, account numbers, tax ids, emails and phone numbers before sending, and asks before sending anything longer than a short lookup. Keep questions general. Its compute tool is hidden (calculations on your numbers stay local); remove it from hiddenTools in mcp.json to opt in.',
  },
};

/**
 * The tools kept away from the model for one server, lower-cased. Matching ignores case, so a server
 * that reports `Compute` for a hidden `compute` is still hidden. A connected server missing from the
 * config (mcp.json was edited since connect) falls back to the preset of the same name, if any.
 */
export function resolveHiddenTools(serverName: string, serverConfig: McpServerConfig | undefined): Set<string> {
  const list = serverConfig ? (serverConfig.hiddenTools ?? []) : (MCP_SERVER_PRESETS[serverName]?.config.hiddenTools ?? []);
  return new Set(list.map((t) => t.toLowerCase()));
}

/** Whether `toolName` is on a set built by resolveHiddenTools. */
export function isHiddenTool(toolName: string, hidden: ReadonlySet<string>): boolean {
  return hidden.has(toolName.toLowerCase());
}

/** Server names usable inside `mcp_<name>_<tool>`: letters, digits, `-` and `_`. */
const SERVER_NAME_RE = /^[A-Za-z0-9_-]{1,40}$/;

interface EditableConfig {
  root: Record<string, unknown>;
  key: 'servers' | 'mcpServers';
  servers: Record<string, unknown>;
}

/**
 * Read mcp.json for editing. A missing file is an empty config; a file that
 * exists but is not a JSON object throws, so a hand-edited file with a typo
 * is never overwritten.
 */
function readConfigForEdit(path: string): EditableConfig {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return { root: {}, key: 'servers', servers: {} };
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${path} is not valid JSON; fix or remove it first`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${path} must contain a JSON object; fix or remove it first`);
  }
  const root = parsed as Record<string, unknown>;
  const key = root.servers === undefined && root.mcpServers !== undefined ? 'mcpServers' : 'servers';
  const servers = root[key] ?? {};
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) {
    throw new Error(`"${key}" in ${path} must be an object; fix it first`);
  }
  return { root, key, servers: servers as Record<string, unknown> };
}

/** Write mcp.json atomically: a temp file in the same directory, then rename over the original. */
function writeConfigAtomic(path: string, file: EditableConfig): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ ...file.root, [file.key]: file.servers }, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

/**
 * Add (or replace) one server in mcp.json, keeping every other server and
 * top-level key as it was. Returns true when an entry of that name was replaced.
 */
export function addMcpServerToConfig(name: string, server: McpServerConfig, path: string = MCP_CONFIG_PATH): boolean {
  if (!SERVER_NAME_RE.test(name)) throw new Error(`Server name "${name}" may only use letters, digits, "-" and "_"`);
  if (isRemoteServer(server)) {
    const urlError = validateRemoteUrl(server.url);
    if (urlError) throw new Error(urlError);
  }
  const file = readConfigForEdit(path);
  const replaced = Object.prototype.hasOwnProperty.call(file.servers, name);
  file.servers = { ...file.servers, [name]: server };
  writeConfigAtomic(path, file);
  return replaced;
}

/** Remove one server from mcp.json. Returns false (and writes nothing) when it was not there. */
export function removeMcpServerFromConfig(name: string, path: string = MCP_CONFIG_PATH): boolean {
  const file = readConfigForEdit(path);
  if (!Object.prototype.hasOwnProperty.call(file.servers, name)) return false;
  const { [name]: _removed, ...rest } = file.servers;
  file.servers = rest;
  writeConfigAtomic(path, file);
  return true;
}

/** The servers in mcp.json as written (unvalidated), for `/mcp list`. A missing file is empty. */
export function readMcpServersForList(path: string = MCP_CONFIG_PATH): Record<string, unknown> {
  return readConfigForEdit(path).servers;
}
