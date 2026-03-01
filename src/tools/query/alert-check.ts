import { z } from 'zod';
import type { Database } from '../../db/compat-sqlite.js';
import { defineTool } from '../define-tool.js';
import { checkAlerts } from '../../alerts/engine.js';
import { formatToolResult } from '../types.js';

let db: Database | null = null;

export function initAlertCheckTool(database: Database): void {
  db = database;
}

function getDb(): Database {
  if (!db) throw new Error('alert_check tool not initialized. Call initAlertCheckTool(database) first.');
  return db;
}

export const alertCheckTool = defineTool({
  name: 'alert_check',
  description:
    'Check for active spending alerts: budget warnings/exceeded, spending spikes, and new recurring charges.',
  schema: z.object({
    types: z.array(z.enum(['budget_warning', 'budget_exceeded', 'spending_spike', 'new_recurring', 'all']))
      .default(['all'])
      .describe('Alert types to check'),
  }),
  func: async ({ types }) => {
    const database = getDb();
    let alerts = checkAlerts(database);

    if (!types.includes('all')) {
      alerts = alerts.filter((a) => types.includes(a.type as any));
    }

    if (alerts.length === 0) {
      return formatToolResult({ message: 'No active alerts.', alerts: [] });
    }

    const formatted = alerts.map((a) => {
      const icon = a.severity === 'critical' ? 'CRITICAL' : a.severity === 'warning' ? 'WARNING' : 'INFO';
      return `[${icon}] ${a.message}`;
    }).join('\n');

    return formatToolResult({
      alertCount: alerts.length,
      alerts,
      formatted: `Active Alerts (${alerts.length})\n\n${formatted}`,
    });
  },
});
