import { describe, test, expect, spyOn, afterEach } from 'bun:test';
import * as fs from 'fs';
import { loadMcpConfig } from '../mcp/config.js';
import { logger } from '../utils/logger.js';

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
  describe('readOnlyTools (the user\'s list of read-only MCP tools)', () => {
    let warnSpy: ReturnType<typeof spyOn>;
    afterEach(() => warnSpy?.mockRestore());

    const load = (server: Record<string, unknown>) => {
      warnSpy = spyOn(logger, 'warn');
      readSpy = spyOn(fs, 'readFileSync').mockReturnValue(JSON.stringify({ servers: { s: { command: 'node', ...server } } }));
      return loadMcpConfig().servers.s;
    };

    test('an array of strings is kept', () => {
      expect(load({ readOnlyTools: ['search', 'lookup'] }).readOnlyTools).toEqual(['search', 'lookup']);
      expect(warnSpy).not.toHaveBeenCalled();
    });

    test('anything but an array of strings is dropped with a warning (no tool becomes read-only)', () => {
      for (const bad of ['search', ['search', 1], { search: true }, true, null, [['nested']]]) {
        const server = load({ readOnlyTools: bad });
        expect(server.readOnlyTools).toBeUndefined();
        expect(server.command).toBe('node');
        expect(String(warnSpy.mock.calls[0]?.[0])).toContain('readOnlyTools');
        warnSpy.mockRestore();
        readSpy.mockRestore();
      }
    });

    test('absent stays absent', () => {
      expect(load({}).readOnlyTools).toBeUndefined();
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });
});
