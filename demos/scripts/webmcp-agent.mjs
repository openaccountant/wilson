// A small, scripted external MCP agent for the Web AI Summit WebMCP demo.
//
// It is a real MCP client (the SDK's Client over Streamable HTTP) with no
// dashboard login of its own: the only thing it holds is the bearer token a
// human copied out of Settings → Agent access. It sees exactly the tools
// granted there, and every mutation it proposes blocks on the dashboard's
// confirmation card until a human approves or rejects it.
//
//   bun demos/scripts/webmcp-agent.mjs --token <token> [--url http://localhost:3141/mcp]
//                                      [--query "PHARMACY PLUS"] [--category <override>]
//                                      [--pace 1200] [--json]
//
// With no --category it does what a sensible agent would: picks the newest
// uncategorized match and proposes the category that same merchant already
// has everywhere else in the ledger.
//
// --json prints one JSON event per line (for record-webmcp-agent.mjs);
// otherwise output is human-readable.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
}

const URL_ = arg('url', 'http://localhost:3141/mcp');
const TOKEN = arg('token', process.env.WILSON_MCP_TOKEN);
const QUERY = arg('query', 'PHARMACY PLUS');
const CATEGORY_OVERRIDE = arg('category', null);
const PACE = Number(arg('pace', '1200'));
const JSON_OUT = process.argv.includes('--json');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();

function emit(kind, text, data) {
  if (JSON_OUT) {
    console.log(JSON.stringify({ t: Date.now() - t0, kind, text, data }));
  } else {
    const tag = { think: '·', call: '→', result: '←', error: '✗', done: '✓' }[kind] ?? ' ';
    console.log(`${tag} ${text}`);
  }
}

function parseResult(res) {
  const text = res.content?.find((c) => c.type === 'text')?.text ?? '';
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function call(client, name, args) {
  emit('call', `${name}(${JSON.stringify(args)})`, { name, args });
  const res = await client.callTool({ name, arguments: args }, undefined, {
    // Mutations block server-side until a human answers the confirmation card.
    timeout: 6 * 60 * 1000,
    resetTimeoutOnProgress: true,
  });
  if (res.isError) {
    const msg = res.content?.map((c) => c.text).join(' ') ?? 'tool error';
    emit('error', `${name} failed: ${msg}`, { name });
    throw new Error(msg);
  }
  return parseResult(res);
}

if (!TOKEN) {
  emit('error', 'No token. Grant tools in Settings → Agent access, then pass --token (or WILSON_MCP_TOKEN).');
  process.exit(2);
}

const client = new Client({ name: 'wilson-demo-agent', version: '1.0.0' });
const transport = new StreamableHTTPClientTransport(new URL(URL_), {
  requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
});

try {
  emit('think', `Connecting to ${URL_}`);
  await client.connect(transport);
  const { tools } = await client.listTools();
  emit('result', `${tools.length} tool${tools.length === 1 ? '' : 's'} granted: ${tools.map((t) => t.name).join(', ') || '(none)'}`, {
    tools: tools.map((t) => t.name),
  });
  if (tools.length === 0) {
    emit('error', 'No tools granted to this token — access was revoked or never given.');
    process.exit(3);
  }
  await sleep(PACE);

  // 1. Read: context — how much is still uncategorized?
  emit('think', 'Checking this month against last month…');
  const summary = await call(client, 'spending_summary', { period: 'month', compareWithPrevious: true });
  const prev = summary?.previousPeriod;
  const prevUncat = prev?.categories?.find((c) => c.category === 'Uncategorized');
  emit(
    'result',
    prevUncat
      ? `${prev.label}: ${prevUncat.count} uncategorized charges ($${Math.abs(prevUncat.total).toFixed(2)})`
      : `${summary?.period ?? 'This month'}: ${summary?.transactionCount ?? 0} transactions`,
    { period: summary?.period, previous: prev?.label, uncategorized: prevUncat }
  );
  await sleep(PACE);

  // 2. Read: find the charge and how this merchant is usually categorized.
  emit('think', `Looking up "${QUERY}"…`);
  const search = await call(client, 'transaction_search', { query: QUERY });
  const rows = search?.transactions ?? [];
  const target = rows.filter((r) => !r.category).sort((a, b) => b.date.localeCompare(a.date))[0];
  if (!target) {
    emit('error', `Nothing uncategorized matches "${QUERY}".`);
    process.exit(4);
  }
  const history = rows.filter((r) => r.category);
  const counts = new Map();
  for (const r of history) counts.set(r.category, (counts.get(r.category) ?? 0) + 1);
  const [usual, usualCount] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] ?? [null, 0];
  emit('result', `${rows.length} matches — #${target.id} ${target.date} ${target.description} $${Math.abs(target.amount).toFixed(2)} is uncategorized`, {
    target,
  });
  const CATEGORY = CATEGORY_OVERRIDE ?? usual;
  if (!CATEGORY) {
    emit('error', 'No history to infer a category from; pass --category.');
    process.exit(4);
  }
  emit('think', CATEGORY_OVERRIDE ? `Using category ${CATEGORY}` : `Same merchant was "${usual}" ${usualCount}/${history.length} times before`);
  await sleep(PACE);

  // 3. Mutate: propose the categorization. Blocks until a human decides.
  emit('think', `Proposing ${CATEGORY} for #${target.id} — waiting for human approval in the dashboard…`);
  const outcome = await call(client, 'categorize_transaction', { id: target.id, category: CATEGORY });
  const status = outcome?.outcome ?? 'unknown';
  emit(status === 'committed' ? 'done' : 'error', `Outcome: ${status}${outcome?.operationId ? ` (operation ${outcome.operationId})` : ''}`, outcome);
  await client.close();
  process.exit(status === 'committed' ? 0 : 1);
} catch (err) {
  emit('error', err instanceof Error ? err.message : String(err));
  process.exit(1);
}
