import { afterAll, beforeAll, describe, expect, setSystemTime, test } from 'bun:test';
import { buildParityFixture, PARITY_NOW, type ParityFixture } from './mirror-tool-fixtures.js';
import { initSpendingSummaryTool, spendingSummaryTool } from '../tools/query/spending-summary.js';
import { initProfitLossTool, profitLossTool } from '../tools/query/profit-loss.js';
import { createMirrorDb } from './mirror-helpers.js';
import { mirrorExecuteRead } from '../dashboard/ui/src/store/mirror-tools.js';

/**
 * Documented divergences between the server tools and the mirror (spec §1.3 /
 * Q7). The server `defineTool` validates args against the zod schema but passes
 * the ORIGINAL args through, so zod `.default()` values are never applied. That
 * used to make `spending_summary({})` and `profit_loss({})` throw; the WebMCP
 * work moved both into shared compute helpers (computeSpendingSummary,
 * computeProfitLoss) that default the period, so they now answer for the current
 * period. What still differs: the server leaves `compareWithPrevious` off when it
 * is omitted, while the mirror applies the schema default (on).
 */

let fx: ParityFixture;

beforeAll(async () => {
  setSystemTime(new Date(PARITY_NOW));
  fx = await buildParityFixture();
  initSpendingSummaryTool(fx.serverDb);
  initProfitLossTool(fx.serverDb);
});

afterAll(() => {
  setSystemTime();
});

describe('known divergence: server schema defaults are not applied', () => {
  test('server spending_summary({}) answers for the current month, without the previous period', async () => {
    const empty = JSON.parse(await (spendingSummaryTool.func as (a: unknown) => Promise<string>)({})).data;
    const month = JSON.parse(await spendingSummaryTool.func({ period: 'month', compareWithPrevious: false })).data;
    expect(empty).toEqual(month);
    expect(empty.previousPeriod).toBeUndefined();
  });

  test('server profit_loss({}) answers for the current month', async () => {
    const empty = JSON.parse(await (profitLossTool.func as (a: unknown) => Promise<string>)({})).data;
    const month = JSON.parse(await profitLossTool.func({ period: 'month', offset: 0 })).data;
    expect(empty).toEqual(month);
  });

  test('mirror spending_summary({}) gets explicit defaults (month, compare on)', async () => {
    const got = await mirrorExecuteRead(fx.mirror, 'spending_summary', {}, new Date(), 'default');
    if (!got.servable) throw new Error('not servable');
    const explicit = await mirrorExecuteRead(fx.mirror, 'spending_summary', { period: 'month', compareWithPrevious: true }, new Date(), 'default');
    if (!explicit.servable) throw new Error('not servable');
    expect(got.data).toEqual(explicit.data as object);
    expect((got.data as { previousPeriod?: unknown }).previousPeriod).toBeDefined();
  });

  test('mirror profit_loss({}) gets explicit defaults (month, offset 0)', async () => {
    const got = await mirrorExecuteRead(fx.mirror, 'profit_loss', {}, new Date(), 'default');
    const explicit = await mirrorExecuteRead(fx.mirror, 'profit_loss', { period: 'month', offset: 0 }, new Date(), 'default');
    if (!got.servable || !explicit.servable) throw new Error('not servable');
    expect(got.data).toEqual(explicit.data as object);
  });

  test('mirror defaults equal the server result for the explicit equivalent args', async () => {
    const server = JSON.parse(await spendingSummaryTool.func({ period: 'month', compareWithPrevious: true })).data;
    const got = await mirrorExecuteRead(fx.mirror, 'spending_summary', {}, new Date(), 'default');
    if (!got.servable) throw new Error('not servable');
    expect(got.data).toEqual(server);
  });
});

describe('phase-2 tools on a mirror that lacks the v4 tables', () => {
  test.each(['net_worth', 'forecast'] as const)('%s resolves missing-tables when accounts is absent', async (tool) => {
    const bare = await createMirrorDb();
    await bare.exec('DROP TABLE accounts');
    const args = tool === 'net_worth' ? { action: 'summary' } : {};
    const got = await mirrorExecuteRead(bare, tool, args, new Date(), 'default');
    expect(got).toEqual({ servable: false, why: 'missing-tables' });
  });
});
