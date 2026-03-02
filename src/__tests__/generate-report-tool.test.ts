import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { existsSync, unlinkSync, readFileSync } from 'fs';
import type { Database } from '../db/compat-sqlite.js';
import { initGenerateReportTool, generateReportTool } from '../tools/export/generate-report.js';
import { createTestDb, seedTestData, makeTmpPath } from './helpers.js';

describe('generate_report tool', () => {
  let db: Database;
  const tmpFiles: string[] = [];

  beforeEach(() => {
    db = createTestDb();
    seedTestData(db);
    initGenerateReportTool(db);
  });

  afterEach(() => {
    for (const f of tmpFiles) {
      try { unlinkSync(f); } catch {}
    }
    tmpFiles.length = 0;
  });

  test('writes report file with header', async () => {
    const filePath = makeTmpPath('.md');
    tmpFiles.push(filePath);

    const raw = await generateReportTool.func({ filePath, month: '2026-02' });
    const result = JSON.parse(raw as string);
    expect(result.data.message).toContain('Report saved');
    expect(existsSync(filePath)).toBe(true);

    const content = readFileSync(filePath, 'utf-8');
    expect(content).toContain('Financial Report');
  });

  test('report contains month label', async () => {
    const filePath = makeTmpPath('.md');
    tmpFiles.push(filePath);

    await generateReportTool.func({ filePath, month: '2026-02' });
    const content = readFileSync(filePath, 'utf-8');
    expect(content).toContain('February 2026');
  });

  test('selective sections only includes requested', async () => {
    const filePath = makeTmpPath('.md');
    tmpFiles.push(filePath);

    await generateReportTool.func({ filePath, month: '2026-02', sections: ['summary'] });
    const content = readFileSync(filePath, 'utf-8');
    expect(content).toContain('## Summary');
    expect(content).not.toContain('## Budget vs Actual');
  });

  test('default sections includes all', async () => {
    const filePath = makeTmpPath('.md');
    tmpFiles.push(filePath);

    await generateReportTool.func({ filePath, month: '2026-02' });
    const content = readFileSync(filePath, 'utf-8');
    expect(content).toContain('## Summary');
    expect(content).toContain('## Spending by Category');
  });

  test('result includes filePath and sections', async () => {
    const filePath = makeTmpPath('.md');
    tmpFiles.push(filePath);

    const raw = await generateReportTool.func({ filePath, month: '2026-02', sections: ['summary', 'spending'] });
    const result = JSON.parse(raw as string);
    expect(result.data.filePath).toBe(filePath);
    expect(result.data.sections).toContain('summary');
    expect(result.data.sections).toContain('spending');
  });

  test('invalid path returns error', async () => {
    const raw = await generateReportTool.func({ filePath: '/nonexistent/dir/report.md', month: '2026-02' });
    const result = JSON.parse(raw as string);
    expect(result.data.error).toContain('Failed to write report');
  });
});
