import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

// Computed import: scripts/ is outside tsconfig's rootDir (same pattern as hybrid-build-gate.test.ts).
const modPath = join(import.meta.dir, '..', '..', 'scripts', 'subagent-route-eval-personas.ts');
const { buildPersonaFixture, PERSONAS, readPersonaRows, resolvePersonasDir } = (await import(modPath)) as {
  PERSONAS: readonly string[];
  resolvePersonasDir(): string | null;
  readPersonaRows(dir: string, persona: string): Array<{ date: string; description: string; amount: number }>;
  buildPersonaFixture(dir: string, persona: string): Promise<{
    serverDb: { prepare(sql: string): { get(): unknown } };
    mirror: { prepare(sql: string): { get(): unknown } };
  }>;
};

/**
 * Round-2 measurement tooling (no product code): builds the per-persona server DB + mirror the
 * held-out v2 rows are asked against, from the synthetic persona seed files through the product's own
 * detectFormat + parsers. Skipped when the synthetic seed directory is not on this machine.
 */
const DIR = resolvePersonasDir();
const t = DIR && existsSync(DIR) ? test : test.skip;

describe('persona fixtures', () => {
  t('row counts per persona match the seed files', () => {
    const counts = Object.fromEntries(PERSONAS.map((p) => [p, readPersonaRows(DIR!, p).length]));
    expect(counts).toEqual({
      '1-comingled-founder': 21,
      '2-new-grad': 13,
      '3-dual-income-household': 13,
      '4-near-retiree': 11,
      '5-single-parent': 14,
    });
  });

  t('amex card charges are stored negative and the planted duplicate survives', () => {
    const rows = readPersonaRows(DIR!, '1-comingled-founder');
    expect(rows.find((r) => r.description.startsWith('STAPLES'))!.amount).toBe(-89.2);
    expect(rows.find((r) => r.description.startsWith('AMEX EPAYMENT'))!.amount).toBe(600);
    expect(rows.filter((r) => r.description === 'ADOBE CREATIVE CLOUD')).toHaveLength(2);
  });

  t('ofx and qif personas parse (dates ISO)', () => {
    const p3 = readPersonaRows(DIR!, '3-dual-income-household');
    const p4 = readPersonaRows(DIR!, '4-near-retiree');
    expect(p3.every((r) => /^2026-06-\d\d$/.test(r.date))).toBe(true);
    expect(p4.every((r) => /^2026-06-\d\d$/.test(r.date))).toBe(true);
    expect(p3.find((r) => r.description.includes('MORTGAGE'))!.amount).toBe(-2100);
  });

  t('the mirror holds exactly the server rows', async () => {
    const fx = await buildPersonaFixture(DIR!, '2-new-grad');
    const server = (fx.serverDb.prepare('SELECT COUNT(*) AS n FROM transactions').get() as { n: number }).n;
    const mirror = (fx.mirror.prepare('SELECT COUNT(*) AS n FROM transactions').get() as { n: number }).n;
    expect(server).toBe(13);
    expect(mirror).toBe(13);
  });

  t('the planted duplicate survives insertion (identical date|desc|amount rows get distinct external ids)', async () => {
    const fx = await buildPersonaFixture(DIR!, '1-comingled-founder');
    const adobe = (fx.serverDb.prepare("SELECT COUNT(*) AS n FROM transactions WHERE description = 'ADOBE CREATIVE CLOUD'").get() as { n: number }).n;
    const mirrorAdobe = (fx.mirror.prepare("SELECT COUNT(*) AS n FROM transactions WHERE description = 'ADOBE CREATIVE CLOUD'").get() as { n: number }).n;
    expect(adobe).toBe(2);
    expect(mirrorAdobe).toBe(2);
  });

  t('unknown persona throws', () => {
    expect(() => readPersonaRows(DIR!, 'nope')).toThrow();
  });
});
