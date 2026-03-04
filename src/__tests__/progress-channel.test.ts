import { describe, expect, test } from 'bun:test';
import { createProgressChannel } from '../utils/progress-channel.js';

describe('createProgressChannel', () => {
  test('basic emit and iterate', async () => {
    const channel = createProgressChannel();
    channel.emit('hello');
    channel.emit('world');
    channel.close();

    const messages: string[] = [];
    for await (const msg of channel) {
      messages.push(msg);
    }
    expect(messages).toEqual(['hello', 'world']);
  });

  test('emit after close is ignored', async () => {
    const channel = createProgressChannel();
    channel.emit('before');
    channel.close();
    channel.emit('after'); // should be silently dropped

    const messages: string[] = [];
    for await (const msg of channel) {
      messages.push(msg);
    }
    expect(messages).toEqual(['before']);
  });

  test('subscriber receives events emitted after await starts', async () => {
    const channel = createProgressChannel();
    const messages: string[] = [];

    // Start consuming in the background
    const consumer = (async () => {
      for await (const msg of channel) {
        messages.push(msg);
      }
    })();

    // Emit after consumer is waiting
    await new Promise((r) => setTimeout(r, 10));
    channel.emit('delayed-1');
    channel.emit('delayed-2');
    channel.close();

    await consumer;
    expect(messages).toEqual(['delayed-1', 'delayed-2']);
  });

  test('unsubscribe pattern — close stops iteration', async () => {
    const channel = createProgressChannel();
    const messages: string[] = [];

    const consumer = (async () => {
      for await (const msg of channel) {
        messages.push(msg);
        if (msg === 'stop') break; // simulate unsubscribe
      }
    })();

    channel.emit('keep');
    channel.emit('stop');
    channel.emit('ignored');

    await consumer;
    expect(messages).toEqual(['keep', 'stop']);
    expect(messages).not.toContain('ignored');
  });

  test('close with no buffered items and pending consumer resolves done', async () => {
    const channel = createProgressChannel();
    const messages: string[] = [];

    const consumer = (async () => {
      for await (const msg of channel) {
        messages.push(msg);
      }
    })();

    // Give consumer time to start waiting
    await new Promise((r) => setTimeout(r, 10));
    // Close without emitting anything
    channel.close();

    await consumer;
    expect(messages).toEqual([]);
  });

  test('interleaved emit and consume', async () => {
    const channel = createProgressChannel();
    const messages: string[] = [];

    const consumer = (async () => {
      for await (const msg of channel) {
        messages.push(msg);
      }
    })();

    for (let i = 0; i < 5; i++) {
      channel.emit(`msg-${i}`);
      await new Promise((r) => setTimeout(r, 5));
    }
    channel.close();

    await consumer;
    expect(messages).toHaveLength(5);
    expect(messages[0]).toBe('msg-0');
    expect(messages[4]).toBe('msg-4');
  });
});
