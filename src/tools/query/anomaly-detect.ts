import { z } from 'zod';
import type { Database } from '../../db/compat-sqlite.js';
import { defineTool } from '../define-tool.js';
import { formatToolResult } from '../types.js';

// Module-level database reference
let db: Database | null = null;

/**
 * Initialize the anomaly_detect tool with a database connection.
 * Must be called before the agent starts.
 */
export function initAnomalyDetectTool(database: Database): void {
  db = database;
}

function getDb(): Database {
  if (!db) {
    throw new Error(
      'anomaly_detect tool not initialized. Call initAnomalyDetectTool(database) first.'
    );
  }
  return db;
}

// ── Anomaly types ─────────────────────────────────────────────────────────────

interface DuplicateAnomaly {
  type: 'duplicate';
  transactions: {
    id: number;
    date: string;
    description: string;
    amount: number;
  }[];
  message: string;
}

interface SpikeAnomaly {
  type: 'spike';
  transaction: {
    id: number;
    date: string;
    description: string;
    amount: number;
  };
  averageAmount: number;
  multiplier: number;
  message: string;
}

interface UnusedSubscriptionAnomaly {
  type: 'unused_subscription';
  merchant: string;
  lastCharge: {
    id: number;
    date: string;
    amount: number;
  };
  daysSinceNonRecurring: number;
  message: string;
}

type Anomaly = DuplicateAnomaly | SpikeAnomaly | UnusedSubscriptionAnomaly;

// ── Detection functions ───────────────────────────────────────────────────────

/**
 * Find potential duplicate transactions: same amount and similar description within 3 days.
 */
function detectDuplicates(database: Database): DuplicateAnomaly[] {
  const rows = database
    .prepare(
      `
      SELECT a.id AS id_a, a.date AS date_a, a.description AS desc_a, a.amount AS amount_a,
             b.id AS id_b, b.date AS date_b, b.description AS desc_b, b.amount AS amount_b
      FROM transactions a
      JOIN transactions b
        ON a.id < b.id
        AND a.amount = b.amount
        AND a.description = b.description
        AND ABS(julianday(a.date) - julianday(b.date)) <= 3
      ORDER BY a.date DESC
      LIMIT 50
    `
    )
    .all() as {
    id_a: number;
    date_a: string;
    desc_a: string;
    amount_a: number;
    id_b: number;
    date_b: string;
    desc_b: string;
    amount_b: number;
  }[];

  return rows.map((row) => ({
    type: 'duplicate' as const,
    transactions: [
      { id: row.id_a, date: row.date_a, description: row.desc_a, amount: row.amount_a },
      { id: row.id_b, date: row.date_b, description: row.desc_b, amount: row.amount_b },
    ],
    message: `Possible duplicate: "${row.desc_a}" for $${Math.abs(row.amount_a).toFixed(2)} on ${row.date_a} and ${row.date_b}`,
  }));
}

/**
 * Find spending spikes: transactions where the amount is > 3x the average for that merchant.
 */
function detectSpikes(database: Database): SpikeAnomaly[] {
  // First get average amounts per description (merchant)
  const rows = database
    .prepare(
      `
      SELECT t.id, t.date, t.description, t.amount,
             stats.avg_amount, stats.txn_count
      FROM transactions t
      JOIN (
        SELECT description,
               AVG(amount) AS avg_amount,
               COUNT(*) AS txn_count
        FROM transactions
        WHERE amount < 0
        GROUP BY description
        HAVING COUNT(*) >= 3
      ) stats ON t.description = stats.description
      WHERE t.amount < 0
        AND ABS(t.amount) > ABS(stats.avg_amount) * 3
      ORDER BY ABS(t.amount) / ABS(stats.avg_amount) DESC
      LIMIT 20
    `
    )
    .all() as {
    id: number;
    date: string;
    description: string;
    amount: number;
    avg_amount: number;
    txn_count: number;
  }[];

  return rows.map((row) => {
    const multiplier = Math.abs(row.amount) / Math.abs(row.avg_amount);
    return {
      type: 'spike' as const,
      transaction: {
        id: row.id,
        date: row.date,
        description: row.description,
        amount: row.amount,
      },
      averageAmount: row.avg_amount,
      multiplier: parseFloat(multiplier.toFixed(1)),
      message: `Spending spike: "${row.description}" charged $${Math.abs(row.amount).toFixed(2)} on ${row.date} (${multiplier.toFixed(1)}x the average of $${Math.abs(row.avg_amount).toFixed(2)})`,
    };
  });
}

/**
 * Find potentially unused subscriptions: recurring charges where the last
 * non-recurring transaction from that merchant was 90+ days ago.
 */
function detectUnusedSubscriptions(database: Database): UnusedSubscriptionAnomaly[] {
  const rows = database
    .prepare(
      `
      SELECT
        r.description AS merchant,
        r.id AS last_charge_id,
        r.date AS last_charge_date,
        r.amount AS last_charge_amount,
        COALESCE(
          (SELECT MAX(nr.date)
           FROM transactions nr
           WHERE nr.description LIKE '%' || r.description || '%'
             AND nr.is_recurring = 0
             AND nr.id != r.id),
          '1970-01-01'
        ) AS last_non_recurring_date
      FROM transactions r
      WHERE r.is_recurring = 1
        AND r.date = (
          SELECT MAX(r2.date)
          FROM transactions r2
          WHERE r2.description = r.description
            AND r2.is_recurring = 1
        )
      GROUP BY r.description
      HAVING julianday('now') - julianday(last_non_recurring_date) >= 90
      ORDER BY r.amount ASC
      LIMIT 20
    `
    )
    .all() as {
    merchant: string;
    last_charge_id: number;
    last_charge_date: string;
    last_charge_amount: number;
    last_non_recurring_date: string;
  }[];

  return rows
    .filter((row) => row.last_non_recurring_date !== '1970-01-01')
    .map((row) => {
      const daysSince = Math.floor(
        (Date.now() - new Date(row.last_non_recurring_date).getTime()) / (1000 * 60 * 60 * 24)
      );
      return {
        type: 'unused_subscription' as const,
        merchant: row.merchant,
        lastCharge: {
          id: row.last_charge_id,
          date: row.last_charge_date,
          amount: row.last_charge_amount,
        },
        daysSinceNonRecurring: daysSince,
        message: `Potentially unused subscription: "${row.merchant}" ($${Math.abs(row.last_charge_amount).toFixed(2)}/charge). No related non-recurring activity in ${daysSince} days.`,
      };
    });
}

// ── Format results ────────────────────────────────────────────────────────────

function formatAnomalies(anomalies: Anomaly[]): string {
  if (anomalies.length === 0) {
    return 'No anomalies detected. Your spending looks normal.';
  }

  const sections: string[] = [];

  const duplicates = anomalies.filter((a): a is DuplicateAnomaly => a.type === 'duplicate');
  const spikes = anomalies.filter((a): a is SpikeAnomaly => a.type === 'spike');
  const unused = anomalies.filter(
    (a): a is UnusedSubscriptionAnomaly => a.type === 'unused_subscription'
  );

  if (duplicates.length > 0) {
    sections.push(
      `POTENTIAL DUPLICATES (${duplicates.length})`,
      ...duplicates.map((d) => `  - ${d.message}`),
      ''
    );
  }

  if (spikes.length > 0) {
    sections.push(
      `SPENDING SPIKES (${spikes.length})`,
      ...spikes.map((s) => `  - ${s.message}`),
      ''
    );
  }

  if (unused.length > 0) {
    sections.push(
      `POTENTIALLY UNUSED SUBSCRIPTIONS (${unused.length})`,
      ...unused.map((u) => `  - ${u.message}`),
      ''
    );
  }

  return [`Anomaly Detection Report`, `Found ${anomalies.length} anomalies:`, '', ...sections].join(
    '\n'
  );
}

// ── Tool definition ───────────────────────────────────────────────────────────

/**
 * Anomaly detection tool — finds duplicates, spending spikes, and unused subscriptions.
 */
export const anomalyDetectTool = defineTool({
  name: 'anomaly_detect',
  description:
    'Detect anomalies in your transactions: duplicate charges, spending spikes, ' +
    'and potentially unused subscriptions.',
  schema: z.object({
    types: z
      .array(z.enum(['duplicates', 'spikes', 'unused_subscriptions', 'all']))
      .default(['all'])
      .describe('Types of anomalies to detect'),
  }),
  func: async ({ types }) => {
    const database = getDb();
    const checkAll = types.includes('all');
    const anomalies: Anomaly[] = [];

    if (checkAll || types.includes('duplicates')) {
      anomalies.push(...detectDuplicates(database));
    }

    if (checkAll || types.includes('spikes')) {
      anomalies.push(...detectSpikes(database));
    }

    if (checkAll || types.includes('unused_subscriptions')) {
      anomalies.push(...detectUnusedSubscriptions(database));
    }

    const formatted = formatAnomalies(anomalies);

    return formatToolResult({
      anomalyCount: anomalies.length,
      duplicates: anomalies.filter((a) => a.type === 'duplicate').length,
      spikes: anomalies.filter((a) => a.type === 'spike').length,
      unusedSubscriptions: anomalies.filter((a) => a.type === 'unused_subscription').length,
      anomalies,
      formatted,
    });
  },
});
