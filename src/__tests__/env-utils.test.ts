import { describe, test, expect, spyOn, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import {
  getApiKeyNameForProvider,
  getProviderDisplayName,
  checkApiKeyExists,
  checkApiKeyExistsForProvider,
  saveApiKeyToEnv,
  saveApiKeyForProvider,
} from '../utils/env.js';

describe('env utils', () => {
  describe('checkApiKeyExistsForProvider', () => {
    let existsSpy: ReturnType<typeof spyOn>;
    let readSpy: ReturnType<typeof spyOn>;

    beforeEach(() => {
      existsSpy = spyOn(fs, 'existsSync').mockReturnValue(false);
    });

    afterEach(() => {
      if (existsSpy) existsSpy.mockRestore();
      if (readSpy) readSpy.mockRestore();
    });

    test('returns true when provider has API key and it exists', () => {
      process.env.OPENAI_API_KEY = 'sk-real-key';
      expect(checkApiKeyExistsForProvider('openai')).toBe(true);
      delete process.env.OPENAI_API_KEY;
    });

    test('returns false when provider has API key but it does not exist', () => {
      delete process.env.OPENAI_API_KEY;
      existsSpy.mockReturnValue(false);
      expect(checkApiKeyExistsForProvider('openai')).toBe(false);
    });

    test('returns true when key exists in .env file', () => {
      delete process.env.OPENAI_API_KEY;
      existsSpy.mockReturnValue(true);
      readSpy = spyOn(fs, 'readFileSync').mockReturnValue('OPENAI_API_KEY=sk-from-env\n');
      expect(checkApiKeyExistsForProvider('openai')).toBe(true);
    });

    test('returns true for provider without API key requirement', () => {
      expect(checkApiKeyExistsForProvider('ollama')).toBe(true);
    });
  });

  describe('getApiKeyNameForProvider', () => {
    test('returns env var name for known provider', () => {
      expect(getApiKeyNameForProvider('openai')).toBe('OPENAI_API_KEY');
      expect(getApiKeyNameForProvider('anthropic')).toBe('ANTHROPIC_API_KEY');
      expect(getApiKeyNameForProvider('google')).toBe('GOOGLE_GENERATIVE_AI_API_KEY');
    });

    test('returns undefined for unknown provider', () => {
      expect(getApiKeyNameForProvider('nonexistent')).toBeUndefined();
    });

    test('returns undefined for provider without API key (ollama)', () => {
      expect(getApiKeyNameForProvider('ollama')).toBeUndefined();
    });
  });

  describe('getProviderDisplayName', () => {
    test('returns display name for known provider', () => {
      expect(getProviderDisplayName('openai')).toBe('OpenAI');
      expect(getProviderDisplayName('anthropic')).toBe('Anthropic');
      expect(getProviderDisplayName('google')).toBe('Google');
    });

    test('returns id as fallback for unknown provider', () => {
      expect(getProviderDisplayName('nonexistent')).toBe('nonexistent');
    });
  });

  describe('checkApiKeyExists', () => {
    let existsSpy: ReturnType<typeof spyOn>;
    let readSpy: ReturnType<typeof spyOn>;
    const savedEnv: Record<string, string | undefined> = {};

    beforeEach(() => {
      savedEnv.TEST_API_KEY = process.env.TEST_API_KEY;
    });

    afterEach(() => {
      if (savedEnv.TEST_API_KEY === undefined) {
        delete process.env.TEST_API_KEY;
      } else {
        process.env.TEST_API_KEY = savedEnv.TEST_API_KEY;
      }
      if (existsSpy) existsSpy.mockRestore();
      if (readSpy) readSpy.mockRestore();
    });

    test('returns true when env var is set with real value', () => {
      process.env.TEST_API_KEY = 'sk-real-key-123';
      expect(checkApiKeyExists('TEST_API_KEY')).toBe(true);
    });

    test('returns false when env var starts with your-', () => {
      process.env.TEST_API_KEY = 'your-api-key-here';
      existsSpy = spyOn(fs, 'existsSync').mockReturnValue(false);
      expect(checkApiKeyExists('TEST_API_KEY')).toBe(false);
    });

    test('falls through to .env file when env var not set', () => {
      delete process.env.TEST_API_KEY;
      existsSpy = spyOn(fs, 'existsSync').mockReturnValue(true);
      readSpy = spyOn(fs, 'readFileSync').mockReturnValue(
        '# Keys\nTEST_API_KEY=sk-from-dotenv\n',
      );
      expect(checkApiKeyExists('TEST_API_KEY')).toBe(true);
    });

    test('returns false when .env file does not exist and env var not set', () => {
      delete process.env.TEST_API_KEY;
      existsSpy = spyOn(fs, 'existsSync').mockReturnValue(false);
      expect(checkApiKeyExists('TEST_API_KEY')).toBe(false);
    });

    test('returns false when .env key value starts with your-', () => {
      delete process.env.TEST_API_KEY;
      existsSpy = spyOn(fs, 'existsSync').mockReturnValue(true);
      readSpy = spyOn(fs, 'readFileSync').mockReturnValue(
        'TEST_API_KEY=your-api-key-here\n',
      );
      expect(checkApiKeyExists('TEST_API_KEY')).toBe(false);
    });
  });

  describe('saveApiKeyToEnv', () => {
    let existsSpy: ReturnType<typeof spyOn>;
    let readSpy: ReturnType<typeof spyOn>;
    let writeSpy: ReturnType<typeof spyOn>;

    afterEach(() => {
      if (existsSpy) existsSpy.mockRestore();
      if (readSpy) readSpy.mockRestore();
      if (writeSpy) writeSpy.mockRestore();
    });

    test('creates new .env file when none exists', () => {
      existsSpy = spyOn(fs, 'existsSync').mockReturnValue(false);
      writeSpy = spyOn(fs, 'writeFileSync').mockImplementation(() => {});

      const result = saveApiKeyToEnv('MY_KEY', 'my-value');
      expect(result).toBe(true);
      expect(writeSpy).toHaveBeenCalledTimes(1);

      const written = writeSpy.mock.calls[0][1] as string;
      expect(written).toContain('MY_KEY=my-value');
      expect(written).toContain('# LLM API Keys');
    });

    test('updates existing key in .env file', () => {
      existsSpy = spyOn(fs, 'existsSync').mockReturnValue(true);
      readSpy = spyOn(fs, 'readFileSync').mockReturnValue(
        '# Keys\nMY_KEY=old-value\nOTHER=keep\n',
      );
      writeSpy = spyOn(fs, 'writeFileSync').mockImplementation(() => {});

      const result = saveApiKeyToEnv('MY_KEY', 'new-value');
      expect(result).toBe(true);

      const written = writeSpy.mock.calls[0][1] as string;
      expect(written).toContain('MY_KEY=new-value');
      expect(written).toContain('OTHER=keep');
      expect(written).not.toContain('old-value');
    });

    test('appends new key to existing .env file', () => {
      existsSpy = spyOn(fs, 'existsSync').mockReturnValue(true);
      readSpy = spyOn(fs, 'readFileSync').mockReturnValue('EXISTING=value\n');
      writeSpy = spyOn(fs, 'writeFileSync').mockImplementation(() => {});

      const result = saveApiKeyToEnv('NEW_KEY', 'new-value');
      expect(result).toBe(true);

      const written = writeSpy.mock.calls[0][1] as string;
      expect(written).toContain('EXISTING=value');
      expect(written).toContain('NEW_KEY=new-value');
    });

    test('returns false when writeFileSync throws', () => {
      existsSpy = spyOn(fs, 'existsSync').mockReturnValue(false);
      writeSpy = spyOn(fs, 'writeFileSync').mockImplementation(() => {
        throw new Error('Permission denied');
      });

      const result = saveApiKeyToEnv('KEY', 'val');
      expect(result).toBe(false);
    });
  });

  describe('saveApiKeyForProvider', () => {
    let existsSpy: ReturnType<typeof spyOn>;
    let writeSpy: ReturnType<typeof spyOn>;

    afterEach(() => {
      if (existsSpy) existsSpy.mockRestore();
      if (writeSpy) writeSpy.mockRestore();
    });

    test('saves key for known provider', () => {
      existsSpy = spyOn(fs, 'existsSync').mockReturnValue(false);
      writeSpy = spyOn(fs, 'writeFileSync').mockImplementation(() => {});

      const result = saveApiKeyForProvider('openai', 'sk-test');
      expect(result).toBe(true);

      const written = writeSpy.mock.calls[0][1] as string;
      expect(written).toContain('OPENAI_API_KEY=sk-test');
    });

    test('returns false for unknown provider (no API key name)', () => {
      const result = saveApiKeyForProvider('nonexistent-provider', 'sk-test');
      expect(result).toBe(false);
    });

    test('returns false for ollama (no API key)', () => {
      const result = saveApiKeyForProvider('ollama', 'some-key');
      expect(result).toBe(false);
    });
  });
});
