import { existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import winston from 'winston';
import { BufferTransport, type LogEntry, type LogLevel, type LogSubscriber } from './logger-buffer-transport.js';
import type { Database } from '../db/compat-sqlite.js';

export type { LogEntry, LogLevel };

/**
 * The debug log (written when OA_DEBUG=1). OA_LOG_FILE moves it — e.g. so a
 * long-running dashboard keeps a log that nothing else rotates or deletes.
 */
export const LOG_FILE = process.env.OA_LOG_FILE || join(homedir(), '.openaccountant', 'logs', 'agent.log');
const LOG_DIR = dirname(LOG_FILE);
const MAX_DATA_LENGTH = 50000;

/**
 * Custom JSON Lines format matching the existing schema:
 * {"ts":"...","level":"...","msg":"...","data":...}
 */
const jsonLinesFormat = winston.format.printf((info) => {
  let data = info.data as unknown;
  if (data !== undefined) {
    const serialized = typeof data === 'string' ? data : JSON.stringify(data);
    if (serialized.length > MAX_DATA_LENGTH) {
      data = serialized.slice(0, MAX_DATA_LENGTH) + '...[truncated]';
    }
  }
  return JSON.stringify({
    ts: new Date().toISOString(),
    level: info.level,
    msg: info.message,
    ...(data !== undefined ? { data } : {}),
  });
});

// ── Build Winston logger ──────────────────────────────────────────────────

const bufferTransport = new BufferTransport({ level: 'debug' });

const winstonLogger = winston.createLogger({
  level: 'debug',
  levels: { error: 0, warn: 1, info: 2, debug: 3 },
  transports: [bufferTransport],
});

// ── File transport (added dynamically) ────────────────────────────────────

let fileTransportAdded = false;

function addFileTransport(): void {
  if (fileTransportAdded) return;
  if (!existsSync(LOG_DIR)) {
    mkdirSync(LOG_DIR, { recursive: true });
  }
  winstonLogger.add(
    new winston.transports.File({
      filename: LOG_FILE,
      maxsize: 5 * 1024 * 1024,
      maxFiles: 1,
      tailable: true,
      format: winston.format.combine(jsonLinesFormat),
    })
  );
  fileTransportAdded = true;
}

// Auto-enable file logging if OA_DEBUG is set
if (process.env.OA_DEBUG === '1') {
  addFileTransport();
}

// ── OTel transport (fire-and-forget async import) ─────────────────────────

let otelShutdown: (() => Promise<void>) | null = null;

if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
  import('./logger-otel.js')
    .then(({ createOtelTransport, shutdownOtel }) => {
      const t = createOtelTransport();
      if (t) {
        winstonLogger.add(t);
        otelShutdown = shutdownOtel;
      }
    })
    .catch(() => {});
}

// ── Public facade ─────────────────────────────────────────────────────────

class LoggerFacade {
  private db: Database | null = null;
  private insertStmt: ReturnType<Database['prepare']> | null = null;

  setDatabase(db: Database): void {
    this.db = db;
    this.insertStmt = db.prepare(
      'INSERT INTO logs (level, message, data) VALUES (@level, @message, @data)'
    );
  }

  private persistToDb(level: string, message: string, data?: unknown): void {
    if (!this.insertStmt) return;
    try {
      this.insertStmt.run({
        level,
        message,
        data: data !== undefined ? JSON.stringify(data) : null,
      });
    } catch { /* don't let DB errors break logging */ }
  }

  debug(message: string, data?: unknown): void {
    winstonLogger.log('debug', message, { data });
    this.persistToDb('debug', message, data);
  }

  info(message: string, data?: unknown): void {
    winstonLogger.log('info', message, { data });
    this.persistToDb('info', message, data);
  }

  warn(message: string, data?: unknown): void {
    winstonLogger.log('warn', message, { data });
    this.persistToDb('warn', message, data);
  }

  error(message: string, data?: unknown): void {
    winstonLogger.log('error', message, { data });
    this.persistToDb('error', message, data);
  }

  subscribe(fn: LogSubscriber): () => void {
    return bufferTransport.subscribe(fn);
  }

  getRecentLogs(): LogEntry[] {
    return bufferTransport.getRecentLogs();
  }

  enableFileLogging(): void {
    addFileTransport();
  }

  clear(): void {
    bufferTransport.clear();
  }

  async shutdown(): Promise<void> {
    if (otelShutdown) {
      await otelShutdown();
    }
  }
}

// Singleton instance
export const logger = new LoggerFacade();

// Flush OTel on process exit
process.on('beforeExit', async () => {
  await logger.shutdown();
});
