/**
 * The `/mcp` slash command: manage the MCP servers Wilson connects to as a
 * client (~/.openaccountant/mcp.json).
 *
 *   /mcp list                  servers in mcp.json
 *   /mcp add openaccountants   the hosted tax-knowledge server (preset; its compute tool is hidden)
 *   /mcp add <name> <url>      any remote server (every tool needs approval)
 *   /mcp remove <name>         drop a server
 *
 * Returns the markdown answer; the TUI shows it. Changes apply on the next
 * start (servers connect at startup).
 */
import {
  MCP_CONFIG_PATH,
  MCP_SERVER_PRESETS,
  addMcpServerToConfig,
  isRemoteServer,
  readMcpServersForList,
  removeMcpServerFromConfig,
  type McpServerConfig,
} from './config.js';
import { sanitizeUntrustedText, stripHiddenChars } from './text-hygiene.js';

/** Bound on a tool description in the `wilson --mcp` listing. */
const LIST_DESCRIPTION_MAX = 80;

/**
 * One tool line of the `wilson --mcp` listing. The name and description come from the server, so they are
 * cleaned before they reach the terminal: C0 / C1 control characters (ESC, CSI, BEL, carriage returns),
 * bidi and zero-width characters are removed, line breaks collapsed, and the description is bounded.
 */
export function formatMcpToolListLine(name: string, description: string | undefined, hidden: boolean): string {
  const mark = hidden ? ' (hidden: not offered to the model)' : '';
  const safeName = stripHiddenChars(String(name)).slice(0, 120);
  const safeDescription = description ? sanitizeUntrustedText(String(description), LIST_DESCRIPTION_MAX) : '';
  return `    - ${safeName}${mark}: ${safeDescription || '(no description)'}`;
}

const USAGE = [
  '**/mcp** — MCP servers Wilson connects to',
  '',
  '  `/mcp list` — show configured servers',
  `  \`/mcp add <preset>\` — add a known server (${Object.keys(MCP_SERVER_PRESETS).join(', ')})`,
  '  `/mcp add <name> <https-url>` — add a remote server (every tool needs approval)',
  '  `/mcp remove <name>` — remove a server',
].join('\n');

const RESTART_NOTE = 'Restart Wilson to apply.';

function describeServer(name: string, raw: unknown): string {
  if (!raw || typeof raw !== 'object') return `- **${name}** — invalid entry`;
  const server = raw as McpServerConfig;
  const where = isRemoteServer(server)
    ? `${server.transport ?? 'http→sse'} ${server.url ?? '(no url)'}`
    : `stdio \`${server.command ?? '(no command)'}\``;
  const readOnly = Array.isArray(server.readOnlyTools) && server.readOnlyTools.length > 0
    ? `read-only: ${server.readOnlyTools.join(', ')}`
    : 'every tool needs approval';
  const hidden = Array.isArray(server.hiddenTools) && server.hiddenTools.length > 0
    ? `; hidden: ${server.hiddenTools.join(', ')} (remove from hiddenTools in mcp.json to opt in)`
    : '';
  return `- **${name}** — ${where} (${readOnly}${hidden})`;
}

export function runMcpCommand(args: string, configPath: string = MCP_CONFIG_PATH): string {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  const [sub, ...rest] = parts;

  try {
    if (!sub || sub === 'list') {
      const servers = readMcpServersForList(configPath);
      const names = Object.keys(servers);
      if (names.length === 0) return `No MCP servers configured.\n\n${USAGE}`;
      return `**MCP servers** (${configPath})\n\n${names.map((n) => describeServer(n, servers[n])).join('\n')}`;
    }

    if (sub === 'add') {
      const [name, url, ...extra] = rest;
      if (!name || extra.length > 0) return USAGE;
      if (!url) {
        const preset = MCP_SERVER_PRESETS[name.toLowerCase()];
        if (!preset) {
          return `Unknown preset "${name}". Known: ${Object.keys(MCP_SERVER_PRESETS).join(', ')} — or use \`/mcp add <name> <https-url>\`.`;
        }
        const replaced = addMcpServerToConfig(name.toLowerCase(), structuredClone(preset.config), configPath);
        return `${replaced ? 'Updated' : 'Added'} MCP server **${name.toLowerCase()}**. ${preset.notice} ${RESTART_NOTE}`;
      }
      const replaced = addMcpServerToConfig(name, { url }, configPath);
      return (
        `${replaced ? 'Updated' : 'Added'} MCP server **${name}** (${url}). Queries to it go to a third-party service; ` +
        `personal details are stripped before sending and every tool needs approval. ${RESTART_NOTE}`
      );
    }

    if (sub === 'remove' || sub === 'rm') {
      const [name, ...extra] = rest;
      if (!name || extra.length > 0) return 'Usage: `/mcp remove <name>`';
      return removeMcpServerFromConfig(name, configPath)
        ? `Removed MCP server **${name}**. ${RESTART_NOTE}`
        : `No MCP server named "${name}".`;
    }

    return USAGE;
  } catch (err) {
    return `Could not update MCP config: ${err instanceof Error ? err.message : String(err)}`;
  }
}
