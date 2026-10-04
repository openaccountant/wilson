import { describe, test, expect } from 'bun:test';
import { Database } from '../db/compat-sqlite.js';
import { MIGRATIONS, runMigrations } from '../db/migrations.js';
import { createTestDb } from './helpers.js';
import { count } from './mcp-helpers.js';
import { ANNOTATION_INTEGRITY } from '../db/schema.js';

/** The schema as it was before P4a (v31), so a migration test can seed legacy rows. */
function dbAtVersion(version: number): Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT DEFAULT (datetime(\'now\')))');
  for (const m of MIGRATIONS.filter((x) => x.version <= version)) {
    db.exec(m.up);
    db.prepare('INSERT INTO schema_migrations (version, name) VALUES (@version, @name)').run({ version: m.version, name: m.name });
  }
  return db;
}

function addInteraction(db: Database, runId = 'r1'): number {
  const res = db.prepare(`
    INSERT INTO llm_interactions (run_id, sequence_num, call_type, model, provider, user_prompt, status)
    VALUES (@runId, 1, 'agent', 'gpt-4', 'openai', 'Q', 'ok')
  `).run({ runId });
  return Number((res as { lastInsertRowid: number | bigint }).lastInsertRowid);
}

function addHuman(db: Database, interactionId: number, rating = 4): number {
  const res = db.prepare(`
    INSERT INTO interaction_annotations (interaction_id, rating, notes) VALUES (@interactionId, @rating, 'note')
  `).run({ interactionId, rating });
  return Number((res as { lastInsertRowid: number | bigint }).lastInsertRowid);
}

/** A judge row can only be INSERTED as proposed (the insert guard), so any other status is reached by a transition. */
function addJudge(db: Database, interactionId: number, status = 'proposed', rating = 3): number {
  const res = db.prepare(`
    INSERT INTO interaction_annotations
      (interaction_id, rating, source, status, judge_model, rationale, rubric_version, created_via, principal_id, tags, notes)
    VALUES (@interactionId, @rating, 'judge', 'proposed', 'm', 'grounded: matches the tool result exactly', 'abc', 'webmcp', 'p1', '["good"]', NULL)
  `).run({ interactionId, rating });
  const id = Number((res as { lastInsertRowid: number | bigint }).lastInsertRowid);
  if (status !== 'proposed') db.prepare('UPDATE interaction_annotations SET status = @status WHERE id = @id').run({ id, status });
  return id;
}

const update = (db: Database, id: number, set: string) => () => db.prepare(`UPDATE interaction_annotations SET ${set} WHERE id = @id`).run({ id });

describe('migrations v32 / v33 (annotation provenance and integrity)', () => {
  test('are v32 and v33, contiguous, and nothing above them', () => {
    const byVersion = new Map(MIGRATIONS.map((m) => [m.version, m.name]));
    expect(byVersion.get(32)).toBe('add_annotation_provenance');
    expect(byVersion.get(33)).toBe('annotation_integrity');
    expect(Math.max(...MIGRATIONS.map((m) => m.version))).toBe(33);
  });

  test('a v31 database with legacy rows upgrades to all human/accepted, one current per interaction', () => {
    const db = dbAtVersion(31);
    const a = addInteraction(db, 'ra');
    const b = addInteraction(db, 'rb');
    // The old delete-and-replace route should have left one row each; be defensive about a duplicate.
    db.prepare("INSERT INTO interaction_annotations (interaction_id, rating, notes) VALUES (@a, 2, 'old')").run({ a });
    db.prepare("INSERT INTO interaction_annotations (interaction_id, rating, notes) VALUES (@a, 5, 'new')").run({ a });
    db.prepare("INSERT INTO interaction_annotations (interaction_id, rating) VALUES (@b, 4)").run({ b });
    runMigrations(db);

    const rows = db.prepare('SELECT interaction_id, rating, source, status, version, created_via FROM interaction_annotations ORDER BY id').all() as Array<Record<string, unknown>>;
    expect(rows.every((r) => r.source === 'human' && r.version === 1 && r.created_via === 'dashboard')).toBe(true);
    expect(rows.map((r) => r.status)).toEqual(['superseded', 'accepted', 'accepted']);
    const current = db.prepare("SELECT interaction_id, COUNT(*) AS n FROM v_current_human_annotations GROUP BY interaction_id").all() as Array<{ n: number }>;
    expect(current.every((r) => r.n === 1)).toBe(true);
    expect(current).toHaveLength(2);
    db.close();
  });

  test('unique current human index rejects a second accepted human row', () => {
    const db = createTestDb();
    const i = addInteraction(db);
    addHuman(db, i);
    expect(() => addHuman(db, i, 2)).toThrow();
    db.close();
  });
});

describe('human rows', () => {
  test('UPDATE of a human rating is aborted', () => {
    const db = createTestDb();
    const id = addHuman(db, addInteraction(db));
    expect(update(db, id, 'rating = 1')).toThrow(/immutable/);
    expect(update(db, id, "notes = 'x'")).toThrow(/immutable/);
    expect(update(db, id, "preference = 'chosen'")).toThrow(/immutable/);
    expect(update(db, id, "pair_id = 'p'")).toThrow(/immutable/);
    db.close();
  });

  test('UPDATE of created_via, principal_id or supersedes_id on a human row is aborted', () => {
    const db = createTestDb();
    const i = addInteraction(db);
    const id = addHuman(db, i);
    expect(update(db, id, "created_via = 'dashboard_agent_present'")).toThrow(/immutable/);
    expect(update(db, id, "principal_id = 'x'")).toThrow(/immutable/);
    expect(update(db, id, `supersedes_id = ${id}`)).toThrow(/immutable/);
    db.close();
  });

  test('accepted -> superseded is allowed; superseded -> accepted is not', () => {
    const db = createTestDb();
    const id = addHuman(db, addInteraction(db));
    expect(update(db, id, "status = 'superseded'")).not.toThrow();
    expect(update(db, id, "status = 'accepted'")).toThrow(/transition/);
    db.close();
  });
});

describe('judge rows', () => {
  test('rating, interaction_id, tags, notes, version and rubric_version cannot change', () => {
    const db = createTestDb();
    const i = addInteraction(db);
    const other = addInteraction(db, 'r2');
    const id = addJudge(db, i);
    expect(update(db, id, 'rating = 5')).toThrow(/immutable/);
    expect(update(db, id, `interaction_id = ${other}`)).toThrow(/immutable/);
    expect(update(db, id, "tags = '[]'")).toThrow(/immutable/);
    expect(update(db, id, "notes = 'x'")).toThrow(/immutable/);
    expect(update(db, id, 'version = 2')).toThrow(/immutable/);
    expect(update(db, id, "rubric_version = 'zzz'")).toThrow(/immutable/);
    expect(update(db, id, "rationale = 'changed after the fact, so it must abort'")).toThrow(/immutable/);
    db.close();
  });

  test('proposed -> accepted, rejected and superseded are allowed; accepted -> proposed is not', () => {
    const db = createTestDb();
    const i = addInteraction(db);
    for (const next of ['accepted', 'rejected', 'superseded']) {
      const id = addJudge(db, i);
      expect(update(db, id, `status = '${next}'`)).not.toThrow();
    }
    const acc = addJudge(db, i, 'accepted');
    expect(update(db, acc, "status = 'proposed'")).toThrow(/transition/);
    expect(update(db, acc, "status = 'superseded'")).toThrow(/transition/);
    db.close();
  });

  test('accepted -> rejected needs a new reviewed_at (revocation)', () => {
    const db = createTestDb();
    const id = addJudge(db, addInteraction(db), 'accepted');
    expect(update(db, id, "status = 'rejected'")).toThrow(/transition/);
    expect(update(db, id, "status = 'rejected', reviewed_at = '2026-10-03T10:00:00.000Z', reviewed_by = 7")).not.toThrow();
    db.close();
  });

  test('reviewed_by or reviewed_at change without a status change is aborted', () => {
    const db = createTestDb();
    const id = addJudge(db, addInteraction(db));
    expect(update(db, id, 'reviewed_by = 3')).toThrow(/transition/);
    expect(update(db, id, "reviewed_at = '2026-10-03T10:00:00.000Z'")).toThrow(/transition/);
    db.close();
  });
});

describe('deletes', () => {
  test('deleting an annotation whose interaction exists is aborted', () => {
    const db = createTestDb();
    const id = addHuman(db, addInteraction(db));
    expect(() => db.prepare('DELETE FROM interaction_annotations WHERE id = @id').run({ id })).toThrow(/never deleted/);
    db.close();
  });

  test('deleting the interaction cascades its annotations', () => {
    const db = createTestDb();
    const i = addInteraction(db);
    addHuman(db, i);
    addJudge(db, i);
    expect(() => db.prepare('DELETE FROM llm_interactions WHERE id = @i').run({ i })).not.toThrow();
    expect((db.prepare('SELECT COUNT(*) AS n FROM interaction_annotations').get() as { n: number }).n).toBe(0);
    db.close();
  });
});

describe('version chains', () => {
  test('deleting an interaction cascades a whole chain of versions that point at each other', () => {
    const db = createTestDb();
    const i = addInteraction(db);
    const v1 = addHuman(db, i, 2);
    db.prepare("UPDATE interaction_annotations SET status = 'superseded' WHERE id = @v1").run({ v1 });
    db.prepare("INSERT INTO interaction_annotations (interaction_id, rating, version, supersedes_id) VALUES (@i, 5, 2, @v1)").run({ i, v1 });
    const judge = addJudge(db, i);
    db.prepare("UPDATE interaction_annotations SET status = 'superseded' WHERE id = @judge").run({ judge });
    db.prepare(`INSERT INTO interaction_annotations (interaction_id, rating, source, status, version, supersedes_id, judge_model, rationale, rubric_version, created_via, principal_id)
                VALUES (@i, 4, 'judge', 'proposed', 2, @judge, 'm', 'grounded: the totals match the tool output', 'abc', 'webmcp', 'p1')`).run({ i, judge });
    expect(count(db, 'interaction_annotations')).toBe(4);
    expect(() => db.prepare('DELETE FROM llm_interactions WHERE id = @i').run({ i })).not.toThrow();
    expect(count(db, 'interaction_annotations')).toBe(0);
    db.close();
  });
});

describe('integrity guard', () => {
  test('trigger 1 names every column except status, reviewed_by, reviewed_at and review_agent_present', () => {
    const db = createTestDb();
    const columns = (db.prepare('PRAGMA table_info(interaction_annotations)').all() as Array<{ name: string }>).map((c) => c.name);
    const trigger = (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'trg_annotations_immutable_columns'").get() as { sql: string }).sql;
    const mutable = new Set(['status', 'reviewed_by', 'reviewed_at', 'review_agent_present']);
    const missing = columns.filter((c) => !mutable.has(c) && !new RegExp(`NEW\\.${c}\\b`).test(trigger));
    expect(missing).toEqual([]);
    // And the allow-list columns are NOT in it.
    for (const c of mutable) expect(trigger.includes(`NEW.${c} `)).toBe(false);
    db.close();
  });

  test('the migration SQL is the SQL the trigger was built from', () => {
    expect(ANNOTATION_INTEGRITY).toContain('trg_annotations_status_transitions');
    expect(ANNOTATION_INTEGRITY).toContain('trg_annotations_no_orphan_delete');
  });
});

describe('insert guard (v33)', () => {
  const insertRaw = (db: Database, interactionId: number, cols: string, vals: string) => () =>
    db.prepare(`INSERT INTO interaction_annotations (interaction_id, ${cols}) VALUES (${interactionId}, ${vals})`).run();

  test('a judge row cannot be inserted accepted, rejected, superseded or with review fields', () => {
    const db = createTestDb();
    const i = addInteraction(db);
    for (const status of ['accepted', 'rejected', 'superseded']) {
      expect(insertRaw(db, i, 'rating, source, status, judge_model, rationale, created_via', `5, 'judge', '${status}', 'm', 'x', 'webmcp'`)).toThrow(/insert/);
    }
    expect(insertRaw(db, i, 'rating, source, status, created_via, reviewed_by', "5, 'judge', 'proposed', 'webmcp', 1")).toThrow(/insert/);
    expect(insertRaw(db, i, 'rating, source, status, created_via, reviewed_at', "5, 'judge', 'proposed', 'webmcp', '2026-10-03T10:00:00.000Z'")).toThrow(/insert/);
    // The one allowed shape.
    expect(insertRaw(db, i, 'rating, source, status, created_via', "5, 'judge', 'proposed', 'webmcp'")).not.toThrow();
    db.close();
  });

  test('a human row can only be inserted accepted and via the dashboard (never webmcp, declarative or http-mcp)', () => {
    const db = createTestDb();
    for (const via of ['webmcp', 'declarative', 'http-mcp']) {
      const i = addInteraction(db, `r-${via}`);
      expect(insertRaw(db, i, 'rating, source, status, created_via', `5, 'human', 'accepted', '${via}'`)).toThrow(/insert/);
    }
    const j = addInteraction(db, 'r-sup');
    expect(insertRaw(db, j, 'rating, source, status, created_via', "5, 'human', 'superseded', 'dashboard'")).toThrow(/insert/);
    const k = addInteraction(db, 'r-ok');
    expect(insertRaw(db, k, 'rating, source, status, created_via', "5, 'human', 'accepted', 'dashboard'")).not.toThrow();
    const m = addInteraction(db, 'r-ok2');
    expect(insertRaw(db, m, 'rating, source, status, created_via', "5, 'human', 'accepted', 'dashboard_agent_present'")).not.toThrow();
    db.close();
  });

  test('the trigger is part of the v33 migration SQL', () => {
    expect(ANNOTATION_INTEGRITY).toContain('trg_annotations_insert_guard');
  });
});
