import { describe, expect, test, beforeEach } from 'bun:test';
import { BufferTransport, type LogEntry } from '../utils/logger-buffer-transport.js';

describe('BufferTransport', () => {
  let transport: BufferTransport;

  beforeEach(() => {
    transport = new BufferTransport({ level: 'debug' });
  });

  test('log() creates LogEntry with correct fields', (done) => {
    transport.log({ level: 'info', message: 'hello world', data: { key: 'val' } }, () => {
      const logs = transport.getRecentLogs();
      expect(logs).toHaveLength(1);
      expect(logs[0].level).toBe('info');
      expect(logs[0].message).toBe('hello world');
      expect(logs[0].data).toEqual({ key: 'val' });
      expect(logs[0].id).toBeTruthy();
      expect(logs[0].timestamp).toBeInstanceOf(Date);
      done();
    });
  });

  test('data field preserved in LogEntry', (done) => {
    transport.log({ level: 'debug', message: 'test', data: [1, 2, 3] }, () => {
      const logs = transport.getRecentLogs();
      expect(logs[0].data).toEqual([1, 2, 3]);
      done();
    });
  });

  test('buffer caps at 50 entries', () => {
    for (let i = 0; i < 60; i++) {
      transport.log({ level: 'info', message: `msg-${i}` }, () => {});
    }
    const logs = transport.getRecentLogs();
    expect(logs).toHaveLength(50);
    expect(logs[0].message).toBe('msg-10');
    expect(logs[49].message).toBe('msg-59');
  });

  test('subscribe receives current logs immediately', () => {
    transport.log({ level: 'info', message: 'existing' }, () => {});
    let received: LogEntry[] = [];
    transport.subscribe((logs) => { received = logs; });
    expect(received).toHaveLength(1);
    expect(received[0].message).toBe('existing');
  });

  test('subscribe notified on new log', () => {
    let received: LogEntry[] = [];
    transport.subscribe((logs) => { received = logs; });
    expect(received).toHaveLength(0);
    transport.log({ level: 'warn', message: 'new entry' }, () => {});
    expect(received).toHaveLength(1);
    expect(received[0].message).toBe('new entry');
  });

  test('unsubscribe stops notifications', () => {
    let callCount = 0;
    const unsub = transport.subscribe(() => { callCount++; });
    // Initial call on subscribe
    expect(callCount).toBe(1);
    transport.log({ level: 'info', message: 'a' }, () => {});
    expect(callCount).toBe(2);
    unsub();
    transport.log({ level: 'info', message: 'b' }, () => {});
    // Should not increase after unsubscribe
    expect(callCount).toBe(2);
  });

  test('getRecentLogs returns shallow copy', () => {
    transport.log({ level: 'info', message: 'test' }, () => {});
    const a = transport.getRecentLogs();
    const b = transport.getRecentLogs();
    expect(a).toEqual(b);
    expect(a).not.toBe(b); // Different array references
  });

  test('clear empties buffer and notifies subscribers', () => {
    transport.log({ level: 'info', message: 'will be cleared' }, () => {});
    let received: LogEntry[] = [{ id: 'placeholder', level: 'info', message: '', timestamp: new Date() }];
    transport.subscribe((logs) => { received = logs; });
    expect(received).toHaveLength(1);
    transport.clear();
    expect(received).toHaveLength(0);
    expect(transport.getRecentLogs()).toHaveLength(0);
  });
});

describe('logger singleton', () => {
  // Import after BufferTransport tests so we know the transport itself works
  test('logger.info adds entry to buffer', async () => {
    const { logger } = await import('../utils/logger.js');
    logger.clear();
    logger.info('test info message');
    // Winston is sync for non-async transports, but give it a tick
    await new Promise(r => setTimeout(r, 10));
    const logs = logger.getRecentLogs();
    expect(logs.length).toBeGreaterThanOrEqual(1);
    const entry = logs.find(l => l.message === 'test info message');
    expect(entry).toBeTruthy();
    expect(entry!.level).toBe('info');
  });

  test('logger.error adds entry with error level', async () => {
    const { logger } = await import('../utils/logger.js');
    logger.clear();
    logger.error('something broke', { code: 500 });
    await new Promise(r => setTimeout(r, 10));
    const logs = logger.getRecentLogs();
    const entry = logs.find(l => l.message === 'something broke');
    expect(entry).toBeTruthy();
    expect(entry!.level).toBe('error');
    expect(entry!.data).toEqual({ code: 500 });
  });

  test('subscribe receives current logs immediately', async () => {
    const { logger } = await import('../utils/logger.js');
    logger.clear();
    logger.info('pre-existing');
    await new Promise(r => setTimeout(r, 10));
    let received: LogEntry[] = [];
    const unsub = logger.subscribe((logs) => { received = logs; });
    expect(received.length).toBeGreaterThanOrEqual(1);
    unsub();
  });

  test('subscribe notified on new log', async () => {
    const { logger } = await import('../utils/logger.js');
    logger.clear();
    let received: LogEntry[] = [];
    const unsub = logger.subscribe((logs) => { received = logs; });
    logger.info('new log');
    await new Promise(r => setTimeout(r, 10));
    expect(received.length).toBeGreaterThanOrEqual(1);
    unsub();
  });
});
