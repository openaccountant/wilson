/**
 * Slice 8 measurement sidecar (no product code). Serves the REAL mirror tool
 * executors (handlePortMessage -> mirrorExecuteRead, args re-validated) over
 * bun:sqlite on the synthetic net-worth parity fixture, so the browser eval
 * harness can run runSubagent end to end without wa-sqlite or a dashboard.
 *
 * Synthetic data only: buildNetWorthFixture() is an in-memory createTestDb.
 * Run by scripts/subagent-route-eval.mjs with HOME pointed at a scratch dir;
 * never touches ~/.openaccountant.
 *
 *   bun scripts/subagent-route-eval-server.ts <port> [<nowIso> <personasDir>]
 *   POST /rpc  {t:'status'} | {t:'toolRead', tool, args, nowIso}  -> port response
 *   Round 2: with <personasDir>, a request may carry {persona}; it is answered from that persona's
 *   mirror (synthetic seed files only; the clock is pinned to <nowIso>). No persona -> the parity fixture.
 */
import { setSystemTime } from 'bun:test';
import { buildNetWorthFixture, PARITY_NOW } from '../src/__tests__/mirror-tool-fixtures.js';
import { buildPersonaFixture, PERSONAS } from './subagent-route-eval-personas.js';
import { handlePortMessage, type PortContext } from '../src/dashboard/ui/src/store/mirror-port-protocol.js';

const port = Number(process.argv[2] ?? 0);
const nowIso = process.argv[3] ?? PARITY_NOW;
const personasDir = process.argv[4];
setSystemTime(new Date(nowIso));
const fx = await buildNetWorthFixture();
const ctx: PortContext = { profile: 'default', boundProfile: 'default', seeded: true, lastSyncedAt: new Date(nowIso).toISOString() };
const personaMirrors = new Map<string, typeof fx.mirror>();
if (personasDir) for (const p of PERSONAS) personaMirrors.set(p, (await buildPersonaFixture(personasDir, p)).mirror);

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type',
  'access-control-allow-methods': 'POST, OPTIONS',
};

const server = Bun.serve({
  port,
  hostname: '127.0.0.1',
  async fetch(req) {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const url = new URL(req.url);
    if (url.pathname !== '/rpc' || req.method !== 'POST') return new Response('not found', { status: 404, headers: CORS });
    const { persona, ...body } = (await req.json()) as Record<string, unknown> & { persona?: string | null };
    let mirror = fx.mirror;
    if (persona) {
      const m = personaMirrors.get(persona);
      if (!m) return new Response(`unknown persona ${persona}`, { status: 400, headers: CORS });
      mirror = m;
    }
    const t0 = performance.now();
    const res = await handlePortMessage(mirror, ctx, { id: 1, ...body });
    return Response.json({ res, execMs: performance.now() - t0 }, { headers: CORS });
  },
});
console.log(`READY ${server.port}`);
