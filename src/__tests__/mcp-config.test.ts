import { describe, test, expect, spyOn, afterEach } from 'bun:test';
import * as fs from 'fs';
import { loadMcpConfig } from '../mcp/config.js';

describe('loadMcpConfig', () => {
  let readSpy: ReturnType<typeof spyOn>;

  afterEach(() => {
    if (readSpy) readSpy.mockRestore();
  });

  test('returns empty config when file is missing', () => {
    readSpy = spyOn(fs, 'readFileSync').mockImplementation(() => {
      throw new Error('ENOENT');
    });

    const config = loadMcpConfig();
    expect(config).toEqual({ servers: {} });
  });

  test('parses valid JSON with servers key', () => {
    const data = {
      servers: {
        myServer: { command: 'node', args: ['server.js'] },
      },
    };
    readSpy = spyOn(fs, 'readFileSync').mockReturnValue(JSON.stringify(data));

    const config = loadMcpConfig();
    expect(config.servers).toEqual(data.servers);
  });

  test('parses valid JSON with mcpServers key', () => {
    const data = {
      mcpServers: {
        sseServer: { url: 'http://localhost:3000/sse' },
      },
    };
    readSpy = spyOn(fs, 'readFileSync').mockReturnValue(JSON.stringify(data));

    const config = loadMcpConfig();
    expect(config.servers).toEqual(data.mcpServers);
  });

  test('returns empty config for invalid JSON', () => {
    readSpy = spyOn(fs, 'readFileSync').mockReturnValue('not valid json {{{');

    const config = loadMcpConfig();
    expect(config).toEqual({ servers: {} });
  });

  test('returns empty config for non-object root (array)', () => {
    readSpy = spyOn(fs, 'readFileSync').mockReturnValue('[1, 2, 3]');

    const config = loadMcpConfig();
    expect(config).toEqual({ servers: {} });
  });

  test('returns empty config for non-object root (string)', () => {
    readSpy = spyOn(fs, 'readFileSync').mockReturnValue('"just a string"');

    const config = loadMcpConfig();
    expect(config).toEqual({ servers: {} });
  });

  test('returns empty config for object without servers/mcpServers', () => {
    readSpy = spyOn(fs, 'readFileSync').mockReturnValue(JSON.stringify({ unrelated: true }));

    const config = loadMcpConfig();
    expect(config).toEqual({ servers: {} });
  });
});
