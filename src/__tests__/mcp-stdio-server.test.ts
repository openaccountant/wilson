import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ElicitRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createTestDb } from './helpers.js';
import {
  buildStdioServer,
  DEFAULT_IMPORT_FOLDERS,
  envFlag,
  MAX_IMPORT_FILE_BYTES,
  parseImportFolders,
  resolveImportTarget,
  resolveUserPath,
} from '../mcp/stdio-server.js';
import { getUncategorizedCount } from '../db/queries.js';
import type { Database } from '../db/compat-sqlite.js';
import { envPathOverride } from '../profile/context.js';

const ROOT = join(import.meta.dir, '..', '..');
const CHASE_CSV = join(ROOT, 'data', 'csv', 'chase', 'standard.csv');

function textOf(result: unknown): string {
  const r = result as CallToolResult;
  return r.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
}

function jsonOf(result: unknown): Record<string, unknown> {
  return JSON.parse(textOf(result)) as Record<string, unknown>;
}

const PROFILE = `mcpbtest-${Math.random().toString(36).slice(2, 10)}`;
const tempDirs: string[] = [];
afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

/**
 * The real thing, the way Claude Desktop runs it: `wilson --mcp-server` as a child process speaking JSON-RPC on stdio,
 * against a throwaway HOME. A fake `security` keeps it off the developer's real keychain (the keychain is not
 * scoped by HOME). Any non-JSON line on stdout would surface as a transport error, so this also proves stdout
 * carries only protocol messages.
 */
describe('wilson --mcp-server (stdio round trip)', () => {
  test('initialize, tools/list, import a Chase CSV, then a spending summary', async () => {
    const home = mkdtempSync(join(tmpdir(), 'wilson-mcp-'));
    tempDirs.push(home);
    const bin = join(home, 'bin');
    mkdirSync(bin);
    // Same pattern as .webmcp-live-bin/security: refuse every keychain call, loudly.
    writeFileSync(join(bin, 'security'), '#!/bin/sh\necho "mcp-stdio test: real keychain access is blocked" >&2\nexit 44\n');
    chmodSync(join(bin, 'security'), 0o755);

    const transport = new StdioClientTransport({
      command: 'bun',
      args: ['run', join(ROOT, 'src', 'index.tsx'), '--mcp-server', '--import-folders', join(ROOT, 'data')],
      cwd: ROOT,
      env: {
        ...(process.env as Record<string, string>),
        HOME: home,
        USERPROFILE: home,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        // Never "default": the keychain account is per profile name and not scoped by HOME.
        WILSON_PROFILE: PROFILE,
        // What the Claude Desktop manifest sets: changes on, and its own approval prompt trusted (this client has no elicitation).
        WILSON_MCP_ALLOW_CHANGES: 'true',
        WILSON_MCP_TRUST_HOST_APPROVAL: '1',
      },
      stderr: 'pipe',
    });
    const protocolErrors: Error[] = [];
    const client = new Client({ name: 'wilson-test', version: '1.0.0' });
    client.onerror = (err) => protocolErrors.push(err);

    try {
      await client.connect(transport);
      expect(client.getServerVersion()?.name).toBe('wilson');
      expect(client.getInstructions()).toContain('import_file');

      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);
      for (const name of [
        'import_file',
        'get_overview',
        'search_transactions',
        'get_spending_summary',
        'list_uncategorized',
        'list_categories',
        'categorize_transactions',
        'get_budgets',
        'list_goals',
        'open_dashboard',
      ]) {
        expect(names).toContain(name);
      }
      // Reads say so; changes do not, so the host asks before running them.
      expect(tools.find((t) => t.name === 'get_spending_summary')?.annotations?.readOnlyHint).toBe(true);
      expect(tools.find((t) => t.name === 'import_file')?.annotations?.readOnlyHint).toBe(false);
      expect(tools.find((t) => t.name === 'categorize_transactions')?.annotations?.readOnlyHint).toBe(false);

      const imported = jsonOf(await client.callTool({ name: 'import_file', arguments: { path: CHASE_CSV } }));
      expect(imported.outcome).toBe('imported');
      expect(imported.transactionsImported).toBe(9);

      // The same file again is skipped, not duplicated.
      const again = jsonOf(await client.callTool({ name: 'import_file', arguments: { path: CHASE_CSV } }));
      expect(again.outcome).toBe('nothing_new');

      const overview = jsonOf(await client.callTool({ name: 'get_overview', arguments: {} }));
      expect(overview.profile).toBe(PROFILE);
      expect(overview.transactions).toBe(9);

      const summary = jsonOf(await client.callTool({ name: 'get_spending_summary', arguments: { period: 'year', compareWithPrevious: false } }));
      expect(Array.isArray(summary.items)).toBe(true);
      expect(typeof summary.totalSpending).toBe('number');

      expect(protocolErrors).toEqual([]);
    } finally {
      await client.close();
    }
  }, 60_000);
});

async function connect(
  db: Database,
  opts: { elicit?: 'accept' | 'decline'; allowChanges?: boolean; trustHostApproval?: boolean } = {}
) {
  const server = buildStdioServer({
    db,
    profile: 'test',
    // Tests opt out explicitly; production defaults to off (see 'fail closed').
    allowChanges: 'allowChanges' in opts ? opts.allowChanges : true,
    importFolders: [join(ROOT, 'data')],
    trustHostApproval: opts.trustHostApproval,
    launchDashboard: async () => ({ url: 'http://127.0.0.1:3141', started: true, opened: false }),
  });
  const client = new Client({ name: 'wilson-test', version: '1.0.0' }, { capabilities: opts.elicit ? { elicitation: {} } : {} });
  const prompts: string[] = [];
  if (opts.elicit) {
    client.setRequestHandler(ElicitRequestSchema, async (req) => {
      prompts.push(String((req.params as { message?: string }).message ?? ''));
      return { action: opts.elicit as 'accept' | 'decline', content: {} };
    });
  }
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  await client.connect(clientSide);
  return { client, prompts };
}

describe('buildStdioServer', () => {
  test('categorize flow: list_uncategorized → categorize_transactions, confirmed through elicitation', async () => {
    const db = createTestDb();
    const { client, prompts } = await connect(db, { elicit: 'accept' });
    await client.callTool({ name: 'import_file', arguments: { path: CHASE_CSV } });

    const categories = jsonOf(await client.callTool({ name: 'list_categories', arguments: {} })).categories as string[];
    expect(categories.length).toBeGreaterThan(0);
    const page = jsonOf(await client.callTool({ name: 'list_uncategorized', arguments: { limit: 3 } }));
    const rows = page.items as Array<{ id: number; desc: string }>;
    expect(rows).toHaveLength(3);

    const before = getUncategorizedCount(db);
    const result = jsonOf(
      await client.callTool({
        name: 'categorize_transactions',
        arguments: { items: rows.map((r) => ({ id: r.id, category: categories[0] })) },
      })
    );
    expect(result.outcome).toBe('committed');
    expect(result.categorized).toBe(3);
    expect(getUncategorizedCount(db)).toBe(before - 3);
    // The person saw a server-built description of every change: one prompt for the import, one for the batch.
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain('import standard.csv');
    expect(prompts[1]).toContain('categorize 3 transactions');
    expect(prompts[1]).toContain(`#${rows[0].id}`);
  });

  test('a declined confirmation changes nothing', async () => {
    const db = createTestDb();
    const { client: importer } = await connect(db, { elicit: 'accept' });
    await importer.callTool({ name: 'import_file', arguments: { path: CHASE_CSV } });

    const { client } = await connect(db, { elicit: 'decline' });
    const page = jsonOf(await client.callTool({ name: 'list_uncategorized', arguments: { limit: 2 } }));
    const ids = (page.items as Array<{ id: number }>).map((r) => r.id);
    const before = getUncategorizedCount(db);
    const categories = jsonOf(await client.callTool({ name: 'list_categories', arguments: {} })).categories as string[];
    const result = jsonOf(
      await client.callTool({ name: 'categorize_transactions', arguments: { items: ids.map((id) => ({ id, category: categories[0] })) } })
    );
    expect(result.outcome).toBe('rejected');
    expect(getUncategorizedCount(db)).toBe(before);

    const imported = jsonOf(await client.callTool({ name: 'import_file', arguments: { path: join(ROOT, 'data', 'csv', 'chase', 'april-2026.csv') } }));
    expect(imported.outcome).toBe('rejected');
  });

  test('one bad item refuses the whole batch', async () => {
    const db = createTestDb();
    const { client } = await connect(db, { trustHostApproval: true });
    await client.callTool({ name: 'import_file', arguments: { path: CHASE_CSV } });
    const page = jsonOf(await client.callTool({ name: 'list_uncategorized', arguments: { limit: 1 } }));
    const id = (page.items as Array<{ id: number }>)[0].id;
    const before = getUncategorizedCount(db);
    const result = await client.callTool({
      name: 'categorize_transactions',
      arguments: { items: [{ id, category: 'Groceries' }, { id: 999_999, category: 'Groceries' }] },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Nothing was changed');
    expect(textOf(result)).toContain('#999999');
    expect(getUncategorizedCount(db)).toBe(before);
  });

  test('import_file refuses paths outside the import folders, non-bank files and missing paths', async () => {
    const db = createTestDb();
    const { client } = await connect(db, { trustHostApproval: true });
    const outside = await client.callTool({ name: 'import_file', arguments: { path: join(ROOT, 'package.json') } });
    expect(outside.isError).toBe(true);
    expect(textOf(outside)).toContain('outside the import folders');
    const notBank = await client.callTool({ name: 'import_file', arguments: { path: join(ROOT, 'data', 'api', 'plaid-standard.json') } });
    expect(notBank.isError).toBe(true);
    const missing = await client.callTool({ name: 'import_file', arguments: { path: join(ROOT, 'data', 'no-such-file.csv') } });
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toContain('No file or folder');
    expect(auditRows(db, 'import_file')[0]).toEqual({ decision: 'denied_policy', error_code: 'outside_import_folders' });
  });

  test('allowChanges=false offers only reads and the dashboard', async () => {
    const db = createTestDb();
    const { client } = await connect(db, { allowChanges: false });
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain('get_spending_summary');
    expect(names).toContain('open_dashboard');
    for (const write of ['import_file', 'categorize_transactions', 'set_budget', 'update_goal', 'set_tax_flag']) {
      expect(names).not.toContain(write);
    }
  });

  test('open_dashboard returns the local URL', async () => {
    const db = createTestDb();
    const { client } = await connect(db);
    const out = jsonOf(await client.callTool({ name: 'open_dashboard', arguments: { openBrowser: false } }));
    expect(out.url).toBe('http://127.0.0.1:3141');
  });

  test('catalog arguments are validated strictly', async () => {
    const db = createTestDb();
    const { client } = await connect(db);
    const res = await client.callTool({ name: 'search_transactions', arguments: { query: 'x', bogus: 1 } });
    expect(res.isError).toBe(true);
  });
});

function auditRows(db: Database, tool: string): Array<{ decision: string; error_code: string | null }> {
  return db
    .prepare(`SELECT decision, error_code FROM mcp_audit_log WHERE transport = 'stdio' AND tool_name = @tool ORDER BY id`)
    .all({ tool }) as Array<{ decision: string; error_code: string | null }>;
}

describe('fail closed', () => {
  test('change tools are absent unless allowChanges is exactly true', async () => {
    const db = createTestDb();
    const server = buildStdioServer({ db, profile: 'test' });
    const client = new Client({ name: 't', version: '1' });
    const [c, s] = InMemoryTransport.createLinkedPair();
    await server.connect(s);
    await client.connect(c);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain('import_file');
    expect(names).not.toContain('categorize_transactions');
    expect(names).toContain('get_overview');
  });

  test('no elicitation and no trusted host: every change is refused, audited denied_policy, nothing written', async () => {
    const db = createTestDb();
    const { client } = await connect(db);
    const res = await client.callTool({ name: 'import_file', arguments: { path: CHASE_CSV } });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('cannot ask the user to confirm');
    expect((db.prepare('SELECT COUNT(*) AS n FROM transactions').get() as { n: number }).n).toBe(0);
    expect(auditRows(db, 'import_file').at(-1)).toEqual({ decision: 'denied_policy', error_code: 'no_confirmation' });

    const cat = db.prepare('SELECT id FROM categories ORDER BY id LIMIT 1').get() as { id: number };
    const budget = await client.callTool({ name: 'set_budget', arguments: { category_id: cat.id, monthly_limit: 500 } });
    expect(textOf(budget)).toContain('cannot ask the user to confirm');
    expect(budget.isError).toBe(true);
    expect(auditRows(db, 'set_budget').at(-1)?.decision).toBe('denied_policy');
  });

  test('a trusted host (its own approval prompt) may change data without elicitation', async () => {
    const db = createTestDb();
    const { client } = await connect(db, { trustHostApproval: true });
    const res = jsonOf(await client.callTool({ name: 'import_file', arguments: { path: CHASE_CSV } }));
    expect(res.outcome).toBe('imported');
  });

  test('change tools are never marked read-only', async () => {
    const { client } = await connect(createTestDb());
    const tools = (await client.listTools()).tools;
    for (const name of ['import_file', 'categorize_transactions', 'set_budget', 'update_goal', 'set_tax_flag']) {
      expect(tools.find((t) => t.name === name)?.annotations?.readOnlyHint).toBe(false);
    }
    expect(tools.find((t) => t.name === 'set_budget')?.annotations?.destructiveHint).toBe(true);
  });
});

describe('import containment', () => {
  const base = mkdtempSync(join(tmpdir(), 'wilson-import-'));
  tempDirs.push(base);
  const root = join(base, 'Downloads');
  const out = join(base, 'secrets');
  mkdirSync(join(root, '.hidden'), { recursive: true });
  mkdirSync(join(root, 'big'), { recursive: true });
  mkdirSync(out, { recursive: true });
  const csv = readFileSync(CHASE_CSV, 'utf-8');
  writeFileSync(join(root, 'ok.csv'), csv);
  writeFileSync(join(root, 'notes.txt'), 'hello');
  writeFileSync(join(root, '.hidden', 'x.csv'), csv);
  writeFileSync(join(out, 'secret.csv'), csv);
  writeFileSync(join(out, 'id_rsa'), 'PRIVATE KEY');
  symlinkSync(join(out, 'secret.csv'), join(root, 'link-out.csv'));
  symlinkSync(join(out, 'id_rsa'), join(root, 'key.csv'));
  symlinkSync(out, join(root, 'linkdir'));
  writeFileSync(join(root, 'big', 'huge.csv'), '');
  truncateSync(join(root, 'big', 'huge.csv'), MAX_IMPORT_FILE_BYTES + 1);
  const folders = [root];
  const deny = (p: string) => {
    const r = resolveImportTarget(p, folders);
    expect(r.ok).toBe(false);
    return r as Extract<ReturnType<typeof resolveImportTarget>, { ok: false }>;
  };

  test('a file in an import folder is allowed', () => {
    const r = resolveImportTarget(join(root, 'ok.csv'), folders);
    expect(r.ok && r.files.map((f) => basename(f))).toEqual(['ok.csv']);
  });

  test('outside the folders, symlinks out, and dot-folders are refused by policy', () => {
    expect(deny(join(out, 'secret.csv'))).toMatchObject({ decision: 'denied_policy', code: 'outside_import_folders' });
    expect(deny(join(root, 'link-out.csv'))).toMatchObject({ decision: 'denied_policy', code: 'outside_import_folders' });
    expect(deny(join(root, 'key.csv'))).toMatchObject({ decision: 'denied_policy', code: 'outside_import_folders' });
    expect(deny(join(root, 'linkdir', 'secret.csv'))).toMatchObject({ decision: 'denied_policy', code: 'outside_import_folders' });
    expect(deny(join(root, '.hidden', 'x.csv'))).toMatchObject({ decision: 'denied_policy', code: 'hidden_folder' });
    expect(deny(join(root, '..', 'secrets', 'secret.csv')).decision).toBe('denied_policy');
    expect(deny('~/.ssh/id_rsa').decision).toBe('denied_policy');
  });

  test('only bank file types, and a size cap', () => {
    expect(deny(join(root, 'notes.txt'))).toMatchObject({ decision: 'denied_policy', code: 'bad_extension' });
    expect(deny(join(root, 'big'))).toMatchObject({ decision: 'denied_policy', code: 'file_too_large' });
  });

  test('a folder import takes only its own regular bank files: no dotfiles, no links out, no subfolders', () => {
    const r = resolveImportTarget(root, folders);
    expect(r.ok && r.files.map((f) => basename(f))).toEqual(['ok.csv']);
  });

  test('no folders configured means no imports', () => {
    expect(resolveImportTarget(join(root, 'ok.csv'), [])).toMatchObject({ ok: false, code: 'no_import_folders' });
  });

  test("the owner's Off policy for import_file refuses it, audited denied_policy", async () => {
    const db = createTestDb();
    db.prepare(`INSERT INTO mcp_tool_policies (user_key, tool_name, policy, updated_at) VALUES (0, 'import_file', 'off', datetime('now'))`).run();
    const { client } = await connect(db, { trustHostApproval: true });
    const res = await client.callTool({ name: 'import_file', arguments: { path: CHASE_CSV } });
    expect(res.isError).toBe(true);
    expect(auditRows(db, 'import_file').at(-1)).toEqual({ decision: 'denied_policy', error_code: 'policy_off' });
  });

  test('parseImportFolders', () => {
    expect(parseImportFolders(['--mcp-server', '--import-folders', '/a', '/b'], undefined)).toEqual(['/a', '/b']);
    expect(parseImportFolders(['--import-folders', '/a', '--profile', 'x'], undefined)).toEqual(['/a']);
    expect(parseImportFolders(['--import-folders', '${user_config.import_folders}'], undefined)).toEqual(DEFAULT_IMPORT_FOLDERS);
    expect(parseImportFolders(['--import-folders'], undefined)).toEqual([]);
    expect(parseImportFolders([], `/x${delimiter}/y`)).toEqual(['/x', '/y']);
    expect(parseImportFolders([], undefined)).toEqual(DEFAULT_IMPORT_FOLDERS);
  });
});

describe('mcpb/manifest.json', () => {
  test('lists exactly the tools the server offers', async () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, 'mcpb', 'manifest.json'), 'utf-8')) as {
      manifest_version: string;
      tools: Array<{ name: string }>;
      server: { mcp_config: { env: Record<string, string> } };
    };
    expect(manifest.manifest_version).toBe('0.3');
    const { client } = await connect(createTestDb());
    const offered = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(manifest.tools.map((t) => t.name).sort()).toEqual(offered);
    // Both launch paths start the stdio server flag (not `--mcp`, which lists MCP client connections).
    const cfg = manifest.server.mcp_config as unknown as { args: string[]; platform_overrides: { win32: { args: string[] } } };
    expect(cfg.args.slice(1)).toEqual(['--mcp-server', '--import-folders', '${user_config.import_folders}']);
    expect(cfg.platform_overrides.win32.args).toEqual(['--mcp-server', '--import-folders', '${user_config.import_folders}']);
    // The settings reach the server through these variables.
    expect(Object.keys(manifest.server.mcp_config.env).sort()).toEqual([
      'WILSON_HOME',
      'WILSON_MCP_ALLOW_CHANGES',
      'WILSON_MCP_TRUST_HOST_APPROVAL',
      'WILSON_PROFILE',
    ]);
    expect(manifest.server.mcp_config.env.WILSON_MCP_TRUST_HOST_APPROVAL).toBe('1');
  });
});

describe('helpers', () => {
  test('envFlag treats blanks and unexpanded placeholders as unset', () => {
    expect(envFlag(undefined, true)).toBe(true);
    expect(envFlag('', false)).toBe(false);
    expect(envFlag('${user_config.allow_changes}', true)).toBe(true);
    expect(envFlag('false', true)).toBe(false);
    expect(envFlag('true', false)).toBe(true);
  });

  test('envPathOverride (WILSON_HOME) ignores blanks and placeholders', () => {
    expect(envPathOverride(undefined)).toBeNull();
    expect(envPathOverride('  ')).toBeNull();
    expect(envPathOverride('${user_config.data_dir}')).toBeNull();
    expect(envPathOverride('/tmp/books')).toBe('/tmp/books');
  });

  test('resolveUserPath expands ~ and strips quotes', () => {
    expect(resolveUserPath('"~/Downloads/a.csv"').endsWith(join('Downloads', 'a.csv'))).toBe(true);
    expect(resolveUserPath('/tmp/x.csv')).toBe('/tmp/x.csv');
  });
});
