import Transport from 'winston-transport';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  id: string;
  level: LogLevel;
  message: string;
  timestamp: Date;
  data?: unknown;
}

export type LogSubscriber = (logs: LogEntry[]) => void;

const MAX_BUFFER = 50;

/**
 * Custom Winston transport that maintains an in-memory ring buffer
 * with pub/sub for the TUI debug panel and dashboard logs tab.
 */
export class BufferTransport extends Transport {
  private logs: LogEntry[] = [];
  private subscribers: Set<LogSubscriber> = new Set();

  constructor(opts?: Transport.TransportStreamOptions) {
    super(opts);
  }

  log(info: Record<string, unknown>, callback: () => void): void {
    const entry: LogEntry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      level: (info.level as LogLevel) ?? 'info',
      message: (info.message as string) ?? '',
      timestamp: new Date(),
      data: info.data as unknown,
    };

    this.logs.push(entry);
    if (this.logs.length > MAX_BUFFER) {
      this.logs = this.logs.slice(-MAX_BUFFER);
    }
    this.emit('logged', info);
    this.notify();
    callback();
  }

  subscribe(fn: LogSubscriber): () => void {
    this.subscribers.add(fn);
    fn([...this.logs]); // Send current logs immediately
    return () => this.subscribers.delete(fn);
  }

  getRecentLogs(): LogEntry[] {
    return [...this.logs];
  }

  clear(): void {
    this.logs = [];
    this.notify();
  }

  private notify(): void {
    this.subscribers.forEach(fn => fn([...this.logs]));
  }
}
