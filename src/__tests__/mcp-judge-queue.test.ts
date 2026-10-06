import { afterEach, describe, expect, test } from 'bun:test';
import { createTestDb, seedTestData } from './helpers.js';
import { bfetch, grantTools, makeUser, testScope } from './mcp-helpers.js';
import { startDashboardServer, stopDashboardServer } from '../dashboard/server.js';
import { setInitialProfile, closeAll } from '../dashboard/db-manager.js';
import { enableAuth, verifyLogin } from '../dashboard/auth.js';
import { principalFor } from '../mcp/audit.js';
import { createOperation, markOperationStatus, revokeGrant } from '../mcp/store.js';
import { setKillSwitch } from '../mcp/engine.js';
import { setGlobalAgentState } from '../mcp/global-state.js';
import { insertProposals, setJudgementDwellMs, writeHumanVersion } from '../training/annotations.js';
import type { Database } from '../db/compat-sqlite.js';

/**
 * P4a judgement queue over HTTP: a human accepts, rejects, bulk-accepts and revokes proposals. Every action needs the
 * dashboard page's browser proof, the admin role when auth is on, and leaves a transport=rest audit row that says
 * whether an agent had live access at the time. A proposal younger than 1 s cannot be accepted.
 */

const servers: Awaited<ReturnType<typeof startDashboardServer>>['server'][] = [];

afterEach(() => {
  for (const s of servers) {
    try { stopDashboardServer(s); } catch { /* */ }
  }
  servers.length = 0;
  closeAll();
  setGlobalAgentState({ enabled: undefined, killSwitchEpoch: undefined }); // the kill-switch test below flips it
});

// Older than the 2 h review-agent window, so a plain accept is a human accept; the window tests use RECENT / backdating.
const OLD = new Date(Date.now() - 3 * 60 * 60_000);
const RECENT = new Date(Date.now() - 60_000);

async function start(options: { auth?: boolean } = {}) {
  const db = createTestDb();
  seedTestData(db);
  setJudgementDwellMs(null); // the real 1 s floor: the tests that need it gone make their proposals old
  let admin: string | undefined;
  let viewer: string | undefined;
  if (options.auth) {
    await makeUser(db, 'admin1', 'admin');
    await makeUser(db, 'viewer1', 'viewer');
    enableAuth(db);
    admin = (await verifyLogin(db, 'admin1', 'password123'))!.token;
    viewer = (await verifyLogin(db, 'viewer1', 'password123'))!.token;
  }
  setInitialProfile('test', db);
  const result = await startDashboardServer(db, 0);
  servers.push(result.server);
  const base = `http://localhost:${result.server.port}`;
  const auth = (token?: string): Record<string, string> => (token ? { Authorization: `Bearer ${token}` } : {});
  const post = (path: string, body?: unknown, token?: string, raw = false) =>
    (raw ? fetch : bfetch)(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...auth(token) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const get = (path: string, token?: string) => bfetch(base + path, { headers: auth(token) });
  return { db, base, admin, viewer, post, get };
}

function addInteraction(db: Database, userPrompt = 'Q'): number {
  const res = db.prepare(`
    INSERT INTO llm_interactions (run_id, sequence_num, call_type, model, provider, user_prompt, response_content, status)
    VALUES (@run, 1, 'agent', 'gpt-4', 'openai', @userPrompt, 'A', 'ok')
  `).run({ run: `run-${Math.random().toString(36).slice(2)}`, userPrompt });
  return (res as { lastInsertRowid: number }).lastInsertRowid as number;
}

function propose(db: Database, interactionId: number, opts: { rating?: number; at?: Date; principal?: string } = {}): number {
  const res = insertProposals(db, {
    principalId: opts.principal ?? 'agent-1',
    createdVia: 'webmcp',
    judgeModel: 'claude-test',
    rubricVersion: 'rv1',
    now: opts.at ?? OLD,
    items: [{ interactionId, rating: opts.rating ?? 4, rationale: 'grounded: every figure matches the tool result' }],
  });
  if (!res.ok || res.ids.length !== 1) throw new Error('not created');
  return res.ids[0];
}

const statusOf = (db: Database, id: number): string => (db.prepare('SELECT status FROM interaction_annotations WHERE id = @id').get({ id }) as { status: string }).status;

describe('GET /api/judgements', () => {
  test('lists proposals newest first with parsed fields, the human rating beside them, and the agreement header', async () => {
    const { db, get } = await start();
    const rated = addInteraction(db);
    writeHumanVersion(db, rated, { rating: 2 }, { createdVia: 'dashboard' });
    const a = propose(db, rated, { rating: 5 });
    const b = propose(db, addInteraction(db), { rating: 3 });
    const res = await get('/api/judgements?status=proposed');
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.judgements.map((j: any) => j.id)).toEqual([b, a]);
    expect(body.judgements[1]).toMatchObject({ interaction_id: rated, rating: 5, human_rating: 2, status: 'proposed', judge_model: 'claude-test', tags: [] });
    expect(body.total).toBe(2);
    expect(body.agreement).toEqual({ n: 1, within1Pct: 0 });
  });

  test('pages with a cursor, rejects an unknown status, and is readable by a viewer', async () => {
    const { db, get, viewer } = await start({ auth: true });
    for (let i = 0; i < 3; i++) propose(db, addInteraction(db));
    const first = (await (await get('/api/judgements?limit=2', viewer)).json()) as any;
    expect(first.judgements).toHaveLength(2);
    expect(first.nextCursor).toBe('2');
    const second = (await (await get(`/api/judgements?limit=2&cursor=${first.nextCursor}`, viewer)).json()) as any;
    expect(second.judgements).toHaveLength(1);
    expect(second.nextCursor).toBeUndefined();
    expect((await get('/api/judgements?status=bogus', viewer)).status).toBe(400);
  });
});

describe('accept, reject, revoke', () => {
  test('accept sets reviewed_by and reviewed_at, changes nothing else, and leaves an audit row', async () => {
    const { db, post, admin } = await start({ auth: true });
    const interaction = addInteraction(db);
    const id = propose(db, interaction);
    const before = db.prepare('SELECT * FROM interaction_annotations WHERE id = @id').get({ id }) as Record<string, unknown>;
    const res = await post(`/api/judgements/${id}/accept`, undefined, admin);
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).judgement).toMatchObject({ id, status: 'accepted' });
    const after = db.prepare('SELECT * FROM interaction_annotations WHERE id = @id').get({ id }) as Record<string, unknown>;
    expect(after.status).toBe('accepted');
    expect(after.reviewed_by).toBe((db.prepare("SELECT id FROM dashboard_users WHERE username = 'admin1'").get() as { id: number }).id);
    expect(typeof after.reviewed_at).toBe('string');
    for (const key of Object.keys(before)) {
      if (!['status', 'reviewed_by', 'reviewed_at', 'review_agent_present'].includes(key)) expect(after[key], key).toEqual(before[key]);
    }
    const audit = db.prepare("SELECT transport, tool_name, args_preview FROM mcp_audit_log WHERE decision = 'rest_write'").all() as any[];
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ transport: 'rest', tool_name: '/api/judgements/:id/accept' });
    expect(audit[0].args_preview).toContain('agent_present=false');
    expect(audit[0].args_preview).toContain(`id=${id}`);
  });

  test('accepting something that is not proposed is a 409; an unknown id is a 404', async () => {
    const { db, post } = await start();
    const id = propose(db, addInteraction(db));
    expect((await post(`/api/judgements/${id}/accept`)).status).toBe(200);
    const again = await post(`/api/judgements/${id}/accept`);
    expect(again.status).toBe(409);
    expect(((await again.json()) as any).error.code).toBe('not_proposed');
    expect((await post(`/api/judgements/${id}/reject`)).status).toBe(409);
    expect((await post('/api/judgements/999999/accept')).status).toBe(404);
    // A human annotation id is not a judgement.
    const human = writeHumanVersion(db, addInteraction(db), { rating: 5 }, { createdVia: 'dashboard' });
    expect((await post(`/api/judgements/${human.id}/accept`)).status).toBe(404);
  });

  test('a proposal younger than 1 s cannot be accepted (409), but can be rejected', async () => {
    const { db, post } = await start();
    const fresh = propose(db, addInteraction(db), { at: new Date() });
    const tooFast = await post(`/api/judgements/${fresh}/accept`);
    expect(tooFast.status).toBe(409);
    expect(((await tooFast.json()) as any).error.code).toBe('approval_too_fast');
    expect(statusOf(db, fresh)).toBe('proposed');
    expect((await post(`/api/judgements/${fresh}/reject`)).status).toBe(200);
    expect(statusOf(db, fresh)).toBe('rejected');
  });

  test('accept without browser proof (no Origin, no Sec-Fetch-Site) is a 403 and changes nothing', async () => {
    const { db, post } = await start();
    const id = propose(db, addInteraction(db));
    const res = await post(`/api/judgements/${id}/accept`, undefined, undefined, true);
    expect(res.status).toBe(403);
    expect(((await res.json()) as any).error.code).toBe('origin_required');
    expect(statusOf(db, id)).toBe('proposed');
    for (const action of ['reject', 'revoke']) expect((await post(`/api/judgements/${id}/${action}`, undefined, undefined, true)).status).toBe(403);
    expect((await post('/api/judgements/bulk', { ids: [id], action: 'accept' }, undefined, true)).status).toBe(403);
  });

  test('a viewer cannot accept, reject, revoke or bulk; an admin can', async () => {
    const { db, post, viewer, admin } = await start({ auth: true });
    const id = propose(db, addInteraction(db));
    for (const path of [`/api/judgements/${id}/accept`, `/api/judgements/${id}/reject`, `/api/judgements/${id}/revoke`]) {
      expect((await post(path, undefined, viewer)).status, path).toBe(403);
    }
    expect((await post('/api/judgements/bulk', { ids: [id], action: 'accept' }, viewer)).status).toBe(403);
    expect(statusOf(db, id)).toBe('proposed');
    expect((await post(`/api/judgements/${id}/accept`, undefined, admin)).status).toBe(200);
  });

  test('revoke turns an accepted judgement into rejected; it needs the accepted state', async () => {
    const { db, post } = await start();
    const id = propose(db, addInteraction(db));
    expect((await post(`/api/judgements/${id}/revoke`)).status).toBe(409); // not accepted yet
    await post(`/api/judgements/${id}/accept`);
    const res = await post(`/api/judgements/${id}/revoke`);
    expect(res.status).toBe(200);
    expect(statusOf(db, id)).toBe('rejected');
    expect(((await res.json()) as any).judgement.status).toBe('rejected');
    expect((await post(`/api/judgements/${id}/revoke`)).status).toBe(409);
  });

  test('A3: an accepted judgement behind a newer proposal is listed under status=accepted and can be revoked there; a viewer cannot revoke', async () => {
    const { db, post, get, admin, viewer } = await start({ auth: true });
    const interaction = addInteraction(db);
    const first = propose(db, interaction, { principal: 'agent-a' });
    expect((await post(`/api/judgements/${first}/accept`, undefined, admin)).status).toBe(200);
    const newer = propose(db, interaction, { principal: 'agent-b' }); // a later proposal on the same interaction
    const accepted = (await (await get('/api/judgements?status=accepted', viewer)).json()) as any;
    expect(accepted.judgements.map((j: any) => j.id)).toEqual([first]);
    expect((await get('/api/interactions?judged=accepted', admin).then((r) => r.json()) as any[]).map((r) => r.id)).toEqual([interaction]);
    expect((await post(`/api/judgements/${first}/revoke`, undefined, viewer)).status).toBe(403);
    expect(statusOf(db, first)).toBe('accepted');
    expect((await post(`/api/judgements/${first}/revoke`, undefined, admin)).status).toBe(200);
    expect(statusOf(db, first)).toBe('rejected');
    expect(statusOf(db, newer)).toBe('proposed');
    expect(((await (await get('/api/judgements?status=accepted', admin)).json()) as any).judgements).toEqual([]);
    expect((await post(`/api/judgements/${first}/revoke`, undefined, admin, true)).status).toBe(403); // no browser proof
  });

  test('accepting records agent_present=true in the audit row when the user has a live agent grant', async () => {
    const { db, post } = await start();
    const id = propose(db, addInteraction(db));
    grantTools(db, testScope(), ['list_interactions']); // a live tab grant for this user and profile
    await post(`/api/judgements/${id}/accept`);
    const row = db.prepare("SELECT args_preview FROM mcp_audit_log WHERE decision = 'rest_write'").get() as { args_preview: string };
    expect(row.args_preview).toContain('agent_present=true');
  });
});

describe('an accept made while an agent had live access', () => {
  const users = (jsonl: string) => jsonl.split('\n').filter(Boolean).map((l) => (JSON.parse(l).messages as any[]).find((m) => m.role === 'user').content);

  test('is marked on the row and in the view, and stays out of the includeJudge export unless includeAgentPresent is also set', async () => {
    const { db, base, post, get } = await start();
    const clean = propose(db, addInteraction(db, 'clean-accept'));
    const present = propose(db, addInteraction(db, 'present-accept'));
    expect((await post(`/api/judgements/${clean}/accept`)).status).toBe(200);
    grantTools(db, testScope(), ['list_interactions']); // a live tab grant for this user and profile
    const res = await post(`/api/judgements/${present}/accept`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).judgement.review_agent_present).toBe(true);
    const flag = (id: number) => (db.prepare('SELECT review_agent_present AS f FROM interaction_annotations WHERE id = @id').get({ id }) as { f: number | null }).f;
    expect(flag(clean)).toBe(0);
    expect(flag(present)).toBe(1);

    const sft = async (qs: string) => users(await (await fetch(`${base}/api/export/training/sft?${qs}`)).text());
    expect(await sft('')).toEqual([]);
    expect(await sft('includeJudge=true')).toEqual(['clean-accept']);
    expect((await sft('includeJudge=true&includeAgentPresent=true')).sort()).toEqual(['clean-accept', 'present-accept']);

    const accepted = (await (await get('/api/judgements?status=accepted')).json()) as any;
    expect(accepted.judgements.map((j: any) => [j.id, j.review_agent_present]).sort()).toEqual([[clean, false], [present, true]].sort());
  });

  test('a bulk accept is marked the same way', async () => {
    const { db, post } = await start();
    const id = propose(db, addInteraction(db));
    grantTools(db, testScope(), ['list_interactions']);
    expect((await post('/api/judgements/bulk', { ids: [id], action: 'accept' })).status).toBe(200);
    expect((db.prepare('SELECT review_agent_present AS f FROM interaction_annotations WHERE id = @id').get({ id }) as { f: number }).f).toBe(1);
  });
});

describe('A2: an accept after the proposing agent was around (window, not just a click-time snapshot)', () => {
  const flag = (db: Database, id: number) => (db.prepare('SELECT review_agent_present AS f FROM interaction_annotations WHERE id = @id').get({ id }) as { f: number | null }).f;
  const users = (jsonl: string) => jsonl.split('\n').filter(Boolean).map((l) => (JSON.parse(l).messages as any[]).find((m) => m.role === 'user').content);

  test('probe: the proposer grant is revoked before the accept; the accept is agent_present=1 and stays out of the includeJudge-only export', async () => {
    const { db, base, post } = await start();
    const scope = testScope();
    const grants = grantTools(db, scope, ['list_interactions']);
    const id = propose(db, addInteraction(db, 'lapsed-grant'), { principal: principalFor(scope.sessionGeneration).id }); // proposal itself is old
    for (const grantId of Object.values(grants)) revokeGrant(db, grantId);
    const control = propose(db, addInteraction(db, 'control'), { principal: 'agent-never-granted' });
    expect((await post(`/api/judgements/${id}/accept`)).status).toBe(200);
    expect((await post(`/api/judgements/${control}/accept`)).status).toBe(200);
    expect(flag(db, id)).toBe(1);
    expect(flag(db, control)).toBe(0);
    const sft = async (qs: string) => users(await (await fetch(`${base}/api/export/training/sft?${qs}`)).text());
    expect(await sft('includeJudge=true')).toEqual(['control']);
    expect((await sft('includeJudge=true&includeAgentPresent=true')).sort()).toEqual(['control', 'lapsed-grant']);
  });

  test('an expired grant and a kill-switch kill count the same; a grant older than 2 hours does not', async () => {
    const { db, post } = await start();
    const expiredScope = testScope();
    grantTools(db, expiredScope, ['list_interactions']);
    db.prepare("UPDATE mcp_grants SET expires_at = '2000-01-01T00:00:00.000Z' WHERE session_generation = @s").run({ s: expiredScope.sessionGeneration });
    const killedScope = testScope();
    grantTools(db, killedScope, ['list_interactions']);
    setKillSwitch(db, false); // kills the grant just made (its created_at is not after the epoch) ...
    setKillSwitch(db, true); // ... and turning it back on does not bring it back
    const staleScope = testScope();
    grantTools(db, staleScope, ['list_interactions']);
    db.prepare("UPDATE mcp_grants SET created_at = @at, expires_at = @at WHERE session_generation = @s").run({ s: staleScope.sessionGeneration, at: new Date(Date.now() - 3 * 60 * 60_000).toISOString() });
    const ids = [expiredScope, killedScope, staleScope].map((sc) => propose(db, addInteraction(db), { principal: principalFor(sc.sessionGeneration).id }));
    for (const id of ids) expect((await post(`/api/judgements/${id}/accept`)).status).toBe(200);
    expect(ids.map((id) => flag(db, id))).toEqual([1, 1, 0]);
  });

  test('a client token principal that held a grant is matched by its token id', async () => {
    const { db, post } = await start();
    const scope = testScope({ sessionGeneration: 'tok:abc123', tokenId: 'abc123' });
    grantTools(db, scope, ['list_interactions']);
    const id = propose(db, addInteraction(db), { principal: 'abc123' });
    await post(`/api/judgements/${id}/accept`);
    expect(flag(db, id)).toBe(1);
  });

  test('a proposal under 2 hours old is flagged on accept and on reject, and in a bulk call; an older one is not', async () => {
    const { db, post } = await start();
    const young = propose(db, addInteraction(db), { at: RECENT });
    const youngRejected = propose(db, addInteraction(db), { at: RECENT });
    const youngBulk = propose(db, addInteraction(db), { at: RECENT });
    const old = propose(db, addInteraction(db));
    await post(`/api/judgements/${young}/accept`);
    await post(`/api/judgements/${youngRejected}/reject`);
    await post('/api/judgements/bulk', { ids: [youngBulk, old], action: 'accept' });
    expect([young, youngRejected, youngBulk, old].map((id) => flag(db, id))).toEqual([1, 1, 1, 0]);
  });
});

describe('POST /api/judgements/bulk', () => {
  test('accepts and rejects up to 10 at once and reports each id', async () => {
    const { db, post } = await start();
    const ids = Array.from({ length: 4 }, () => propose(db, addInteraction(db)));
    const res = await post('/api/judgements/bulk', { ids: [ids[0], ids[1], 999999], action: 'accept' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.results).toEqual([
      { id: ids[0], ok: true },
      { id: ids[1], ok: true },
      { id: 999999, ok: false, reason: 'not_found' },
    ]);
    expect(statusOf(db, ids[0])).toBe('accepted');
    const rejected = await post('/api/judgements/bulk', { ids: [ids[2], ids[3]], action: 'reject' });
    expect(((await rejected.json()) as any).results.every((r: any) => r.ok)).toBe(true);
    expect(statusOf(db, ids[3])).toBe('rejected');
  });

  test('more than 10 ids, none, duplicates, or an unknown action is a 400', async () => {
    const { db, post, base } = await start();
    const id = propose(db, addInteraction(db));
    const eleven = Array.from({ length: 11 }, (_, i) => i + 1);
    for (const body of [{ ids: eleven, action: 'accept' }, { ids: [], action: 'accept' }, { ids: [id, id], action: 'accept' }, { ids: [id], action: 'revoke' }, { ids: [id] }, { ids: ['x'], action: 'accept' }]) {
      expect((await post('/api/judgements/bulk', body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(statusOf(db, id)).toBe('proposed');
    const invalidJson = await bfetch(`${base}/api/judgements/bulk`, { method: 'POST', body: '{nope' });
    expect(invalidJson.status).toBe(400);
  });

  test('a fresh proposal in the batch is refused with too_fast while the old ones go through', async () => {
    const { db, post } = await start();
    const old = propose(db, addInteraction(db));
    const fresh = propose(db, addInteraction(db), { at: new Date() });
    const body = (await (await post('/api/judgements/bulk', { ids: [old, fresh], action: 'accept' })).json()) as any;
    expect(body.results).toEqual([{ id: old, ok: true }, { id: fresh, ok: false, reason: 'too_fast' }]);
  });
});

describe('annotate route over HTTP', () => {
  test('rating 9 is a 400 with an error body, an unknown interaction a 404, a good call a 200 with the annotation', async () => {
    const { db, post, base } = await start();
    const id = addInteraction(db);
    const bad = await post(`/api/interactions/${id}/annotate`, { rating: 9 });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as any).error.code).toBe('invalid_args');
    expect((await post('/api/interactions/999999/annotate', { rating: 3 })).status).toBe(404);
    const ok = await post(`/api/interactions/${id}/annotate`, { rating: 4, notes: 'fine' });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as any).annotation).toMatchObject({ rating: 4, notes: 'fine', source: 'human', status: 'accepted', version: 1 });
    expect((await bfetch(`${base}/api/interactions/${id}/annotate`, { method: 'POST', body: 'not json' })).status).toBe(400);
  });

  test('annotating while the user has a live agent grant stores created_via dashboard_agent_present and audits it', async () => {
    const { db, post } = await start();
    const id = addInteraction(db);
    await post(`/api/interactions/${id}/annotate`, { rating: 5 });
    expect((db.prepare("SELECT created_via FROM interaction_annotations WHERE status = 'accepted'").get() as { created_via: string }).created_via).toBe('dashboard');
    grantTools(db, testScope(), ['get_interaction']);
    await post(`/api/interactions/${id}/annotate`, { rating: 4 });
    expect((db.prepare("SELECT created_via FROM interaction_annotations WHERE status = 'accepted'").get() as { created_via: string }).created_via).toBe('dashboard_agent_present');
    const audit = db.prepare("SELECT tool_name, args_preview FROM mcp_audit_log WHERE decision = 'rest_write' ORDER BY id").all() as any[];
    expect(audit.map((a) => a.tool_name)).toEqual(['/api/interactions/:id/annotate', '/api/interactions/:id/annotate']);
    expect(audit.map((a) => a.args_preview)).toEqual(['agent_present=false', 'agent_present=true']);
  });

  test('F1: a headerless POST (no browser proof) is a 403 origin_required and writes nothing', async () => {
    const { db, post } = await start();
    const id = addInteraction(db);
    const res = await post(`/api/interactions/${id}/annotate`, { rating: 5 }, undefined, true);
    expect(res.status).toBe(403);
    expect(((await res.json()) as any).error.code).toBe('origin_required');
    expect((db.prepare('SELECT COUNT(*) AS n FROM interaction_annotations').get() as { n: number }).n).toBe(0);
  });

  test('F1: a flagged label stays dashboard_agent_present after the grant is revoked and the kill switch flips, even on a full-fields re-send, and stays out of the default SFT export', async () => {
    const { db, base, post } = await start();
    const id = addInteraction(db, 'flagged-label');
    const grants = grantTools(db, testScope(), ['get_interaction']);
    await post(`/api/interactions/${id}/annotate`, { rating: 5 });
    const current = () => db.prepare("SELECT created_via, version FROM interaction_annotations WHERE interaction_id = @id AND status = 'accepted'").get({ id }) as { created_via: string; version: number };
    expect(current().created_via).toBe('dashboard_agent_present');
    for (const grantId of Object.values(grants)) revokeGrant(db, grantId);
    setKillSwitch(db, false);
    setKillSwitch(db, true);
    // every label field re-sent: the inheritance rule alone would clear the flag, the window rule must not
    const full = await post(`/api/interactions/${id}/annotate`, { rating: 5, preference: 'chosen', pairId: 'p1', tags: ['t'], notes: 'again' });
    expect(full.status).toBe(200);
    expect(current()).toEqual({ created_via: 'dashboard_agent_present', version: 2 });
    const sft = async (qs: string) => (await (await fetch(`${base}/api/export/training/sft?${qs}`)).text()).split('\n').filter(Boolean).length;
    expect(await sft('')).toBe(0);
    expect(await sft('includeAgentPresent=true')).toBe(1);
    // the audit row of the re-send records the same flag the stored label got (window rule), not a live-only check
    const audit = db.prepare("SELECT args_preview FROM mcp_audit_log WHERE decision = 'rest_write' AND tool_name = '/api/interactions/:id/annotate' ORDER BY id DESC LIMIT 1").get() as { args_preview: string };
    expect(audit.args_preview).toContain('agent_present=true');
  });

  test('F1: the window covers a lapsed grant and a non-chat operation, and not a grant older than 2 hours', async () => {
    const { db, post } = await start();
    const via = (id: number) => (db.prepare("SELECT created_via AS v FROM interaction_annotations WHERE interaction_id = @id AND status = 'accepted'").get({ id }) as { v: string }).v;
    const stale = addInteraction(db);
    const staleScope = testScope();
    grantTools(db, staleScope, ['get_interaction']);
    db.prepare('UPDATE mcp_grants SET created_at = @at, expires_at = @at WHERE session_generation = @s').run({ s: staleScope.sessionGeneration, at: new Date(Date.now() - 3 * 60 * 60_000).toISOString() });
    await post(`/api/interactions/${stale}/annotate`, { rating: 3 });
    expect(via(stale)).toBe('dashboard');

    const lapsed = addInteraction(db);
    const lapsedScope = testScope();
    grantTools(db, lapsedScope, ['get_interaction']);
    db.prepare("UPDATE mcp_grants SET expires_at = '2000-01-01T00:00:00.000Z' WHERE session_generation = @s").run({ s: lapsedScope.sessionGeneration });
    await post(`/api/interactions/${lapsed}/annotate`, { rating: 3 });
    expect(via(lapsed)).toBe('dashboard_agent_present');
  });

  test('F1: a non-chat operation raised in the window (even one no longer pending) marks an annotation; a chat one does not', async () => {
    const { db, post } = await start();
    const op = (source: 'webmcp' | 'chat') => createOperation(db, {
      source, grantId: null, toolName: 'update_transaction', args: {}, before: null, after: null, transactionId: null,
      revisionAtPrepare: null, profile: 'test', origin: 'http://localhost', sessionGeneration: crypto.randomUUID(), userId: null, role: 'admin', ttlMs: 1000,
    });
    const first = addInteraction(db);
    op('chat');
    await post(`/api/interactions/${first}/annotate`, { rating: 3 });
    const via = (id: number) => (db.prepare("SELECT created_via AS v FROM interaction_annotations WHERE interaction_id = @id AND status = 'accepted'").get({ id }) as { v: string }).v;
    expect(via(first)).toBe('dashboard');
    const second = addInteraction(db);
    markOperationStatus(db, op('webmcp').id, 'expired'); // no longer pending: only the window rule can still see it
    await post(`/api/interactions/${second}/annotate`, { rating: 3 });
    expect(via(second)).toBe('dashboard_agent_present');
  });

  test('a viewer cannot annotate', async () => {
    const { db, post, viewer } = await start({ auth: true });
    const id = addInteraction(db);
    expect((await post(`/api/interactions/${id}/annotate`, { rating: 3 }, viewer)).status).toBe(403);
  });

  test('the detail route returns the current annotation, the history and the judgements', async () => {
    const { db, post, get } = await start();
    const id = addInteraction(db);
    await post(`/api/interactions/${id}/annotate`, { rating: 2 });
    await post(`/api/interactions/${id}/annotate`, { rating: 5 });
    propose(db, id, { rating: 3 });
    const detail = (await (await get(`/api/interactions/${id}`)).json()) as any;
    expect(detail.annotation.rating).toBe(5);
    expect(detail.history.map((h: any) => h.rating)).toEqual([5, 2]);
    expect(detail.judgements).toHaveLength(1);
    const list = (await (await get('/api/interactions?judged=proposed')).json()) as any[];
    expect(list.map((r) => r.id)).toEqual([id]);
  });
});

describe('training export routes', () => {
  async function seeded() {
    const ctx = await start({ auth: true });
    const { db } = ctx;
    const human = addInteraction(db, 'human-rated');
    writeHumanVersion(db, human, { rating: 5 }, { createdVia: 'dashboard' });
    const judged = addInteraction(db, 'judge-rated');
    const row = propose(db, judged, { rating: 5 });
    await ctx.post(`/api/judgements/${row}/accept`, undefined, ctx.admin);
    const present = addInteraction(db, 'agent-present-rated');
    writeHumanVersion(db, present, { rating: 5 }, { createdVia: 'dashboard_agent_present' });
    const handoff = addInteraction(db, '[On-device assistant notes — UNTRUSTED.]\nx\n[End of on-device assistant notes]\n\nhanded off');
    writeHumanVersion(db, handoff, { rating: 5 }, { createdVia: 'dashboard' });
    return ctx;
  }

  const users = (jsonl: string) => jsonl.split('\n').filter(Boolean).map((l) => (JSON.parse(l).messages as any[]).find((m) => m.role === 'user').content.slice(0, 20));

  test('the default export is human labels only and says so in X-Wilson-Export-Provenance', async () => {
    const { base, admin } = await seeded();
    const res = await fetch(`${base}/api/export/training/sft`, { headers: { Authorization: `Bearer ${admin}` } });
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Wilson-Export-Provenance')).toBe('human');
    expect(res.headers.get('Content-Disposition')).toContain('wilson-sft.jsonl');
    expect(users(await res.text())).toEqual(['human-rated']);
  });

  test('each opt-in is separate: judge, agent-present, handoff; the header and the file name follow', async () => {
    const { base, admin } = await seeded();
    const get = (qs: string) => fetch(`${base}/api/export/training/sft?${qs}`, { headers: { Authorization: `Bearer ${admin}` } });
    const withJudge = await get('includeJudge=true');
    expect(withJudge.headers.get('X-Wilson-Export-Provenance')).toBe('human+judge');
    expect(withJudge.headers.get('Content-Disposition')).toContain('wilson-sft-with-judge.jsonl');
    expect(users(await withJudge.text()).sort()).toEqual(['human-rated', 'judge-rated']);

    const withPresent = await get('includeAgentPresent=true');
    expect(withPresent.headers.get('X-Wilson-Export-Provenance')).toBe('human+agent-present');
    expect(users(await withPresent.text()).sort()).toEqual(['agent-present-rated', 'human-rated']);

    const withHandoff = await get('includeHandoff=true');
    expect(withHandoff.headers.get('X-Wilson-Export-Provenance')).toBe('human+handoff');
    expect((await withHandoff.text()).split('\n').filter(Boolean)).toHaveLength(2);

    const all = await get('includeJudge=true&includeAgentPresent=true&includeHandoff=true');
    expect(all.headers.get('X-Wilson-Export-Provenance')).toBe('human+judge+agent-present+handoff');
    expect((await all.text()).split('\n').filter(Boolean)).toHaveLength(4);
    // Anything but the literal "true" is off.
    expect((await get('includeJudge=1')).headers.get('X-Wilson-Export-Provenance')).toBe('human');
  });

  test('opt-in exports leave audit rows that tell them apart from a default export, and note an agent grant', async () => {
    const { base, admin, db } = await seeded();
    const hit = (qs: string) => fetch(`${base}/api/export/training/sft?${qs}`, { headers: { Authorization: `Bearer ${admin}` } });
    await hit('');
    await hit('includeJudge=true');
    await hit('includeJudge=true&includeAgentPresent=true');
    await hit('includeJudge=true'); // folds into the previous includeJudge row
    const rows = db.prepare("SELECT args_preview, count FROM mcp_audit_log WHERE decision = 'rest_export' AND tool_name = '/api/export/training/sft' ORDER BY id").all() as Array<{ args_preview: string; count: number }>;
    expect(rows.map((r) => r.args_preview)).toEqual([
      'provenance=human agent_present=false',
      'provenance=human+judge agent_present=false',
      'provenance=human+judge+agent-present agent_present=false',
    ]);
    expect(rows.map((r) => r.count)).toEqual([1, 2, 1]);
    const adminId = (db.prepare("SELECT id FROM dashboard_users WHERE username = 'admin1'").get() as { id: number }).id;
    grantTools(db, testScope({ userId: adminId }), ['list_interactions']); // a live grant for the signed-in admin
    await hit('includeJudge=true');
    const last = db.prepare("SELECT args_preview FROM mcp_audit_log WHERE decision = 'rest_export' ORDER BY id DESC LIMIT 1").get() as { args_preview: string };
    expect(last.args_preview).toBe('provenance=human+judge agent_present=true');
  });

  test('the DPO export and the stats route take the same flags, and ?token= still works with auth on', async () => {
    const { base, admin, db } = await seeded();
    const c = addInteraction(db, 'P');
    const r = addInteraction(db, 'P');
    writeHumanVersion(db, c, { preference: 'chosen', pairId: 'x' }, { createdVia: 'dashboard' });
    writeHumanVersion(db, r, { preference: 'rejected', pairId: 'x' }, { createdVia: 'dashboard_agent_present' });
    const dpo = await fetch(`${base}/api/export/training/dpo?token=${admin}`);
    expect(dpo.status).toBe(200);
    expect(dpo.headers.get('X-Wilson-Export-Provenance')).toBe('human');
    expect(await dpo.text()).toBe('');
    const withPresent = await fetch(`${base}/api/export/training/dpo?token=${admin}&includeAgentPresent=true`);
    expect((await withPresent.text()).split('\n').filter(Boolean)).toHaveLength(1);

    const stats = (await (await fetch(`${base}/api/export/training/stats?token=${admin}`)).json()) as any;
    expect(stats).toMatchObject({ sftReady: 1, dpoPairs: 0, judge: { accepted: 1 } });
    expect(stats.handoffExcluded.sft).toBe(1);
    expect((await fetch(`${base}/api/export/training/sft`)).status).toBe(401);
  });
});
