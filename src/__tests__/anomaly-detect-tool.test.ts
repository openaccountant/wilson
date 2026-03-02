import { describe, expect, test, beforeEach } from 'bun:test';
import type { Database } from '../db/compat-sqlite.js';
import { initAnomalyDetectTool, anomalyDetectTool } from '../tools/query/anomaly-detect.js';
import { insertTransactions } from '../db/queries.js';
import { createTestDb, seedSpikeData } from './helpers.js';

describe('anomaly_detect tool', () => {
  let db: Database;

  beforeEach(() => {
    db = createTestDb();
    initAnomalyDetectTool(db);
  });

  test('no anomalies on empty DB', async () => {
    const raw = await anomalyDetectTool.func({ types: ['all'] });
    const result = JSON.parse(raw as string);
    expect(result.data.anomalyCount).toBe(0);
    expect(result.data.formatted).toContain('No anomalies');
  });

  test('detects duplicate transactions', async () => {
    // Insert duplicate: same amount, same description, within 3 days
    insertTransactions(db, [
      { date: '2026-02-15', description: 'AMAZON.COM', amount: -42.99, category: 'Shopping' },
      { date: '2026-02-16', description: 'AMAZON.COM', amount: -42.99, category: 'Shopping' },
    ]);
    initAnomalyDetectTool(db);

    const raw = await anomalyDetectTool.func({ types: ['duplicates'] });
    const result = JSON.parse(raw as string);
    expect(result.data.duplicates).toBeGreaterThan(0);
  });

  test('detects spending spike', async () => {
    seedSpikeData(db, 'COFFEE SHOP');
    initAnomalyDetectTool(db);

    const raw = await anomalyDetectTool.func({ types: ['spikes'] });
    const result = JSON.parse(raw as string);
    expect(result.data.spikes).toBeGreaterThan(0);
    const spike = result.data.anomalies.find((a: any) => a.type === 'spike');
    expect(spike.multiplier).toBeGreaterThan(3);
  });

  test('type filter only returns requested types', async () => {
    insertTransactions(db, [
      { date: '2026-02-15', description: 'DUP', amount: -10, category: 'Other' },
      { date: '2026-02-16', description: 'DUP', amount: -10, category: 'Other' },
    ]);
    initAnomalyDetectTool(db);

    const raw = await anomalyDetectTool.func({ types: ['spikes'] });
    const result = JSON.parse(raw as string);
    // Should only check spikes, not duplicates
    expect(result.data.duplicates).toBe(0);
  });

  test('formatted output contains report header when anomalies found', async () => {
    insertTransactions(db, [
      { date: '2026-02-15', description: 'DUP', amount: -10, category: 'Other' },
      { date: '2026-02-16', description: 'DUP', amount: -10, category: 'Other' },
    ]);
    initAnomalyDetectTool(db);

    const raw = await anomalyDetectTool.func({ types: ['all'] });
    const result = JSON.parse(raw as string);
    if (result.data.anomalyCount > 0) {
      expect(result.data.formatted).toContain('Anomaly Detection Report');
    }
  });
});
