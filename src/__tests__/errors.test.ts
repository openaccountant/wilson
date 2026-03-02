import { describe, expect, test } from 'bun:test';
import {
  isContextOverflowError,
  isRateLimitError,
  isBillingError,
  isAuthError,
  isTimeoutError,
  isOverloadedError,
  classifyError,
  isNonRetryableError,
  parseApiErrorInfo,
  formatUserFacingError,
} from '../utils/errors.js';

describe('isContextOverflowError', () => {
  test('returns false for undefined/null/empty', () => {
    expect(isContextOverflowError(undefined)).toBe(false);
    expect(isContextOverflowError('')).toBe(false);
  });

  test('detects "context length exceeded"', () => {
    expect(isContextOverflowError('context length exceeded')).toBe(true);
  });

  test('detects "maximum context length"', () => {
    expect(isContextOverflowError('maximum context length reached')).toBe(true);
  });

  test('detects "prompt is too long"', () => {
    expect(isContextOverflowError('prompt is too long for this model')).toBe(true);
  });

  test('detects "request_too_large"', () => {
    expect(isContextOverflowError('request_too_large')).toBe(true);
  });

  test('detects "413 too large"', () => {
    expect(isContextOverflowError('413 payload too large')).toBe(true);
  });

  test('detects "model token limit"', () => {
    expect(isContextOverflowError('your request exceeded model token limit')).toBe(true);
  });

  test('excludes TPM rate limit errors', () => {
    expect(isContextOverflowError('tpm limit exceeded for context')).toBe(false);
    expect(isContextOverflowError('tokens per minute context limit')).toBe(false);
  });

  test('detects Chinese context overflow messages', () => {
    expect(isContextOverflowError('上下文过长')).toBe(true);
    expect(isContextOverflowError('上下文超出')).toBe(true);
    expect(isContextOverflowError('超出最大上下文')).toBe(true);
  });
});

describe('isRateLimitError', () => {
  test('returns false for undefined/empty', () => {
    expect(isRateLimitError(undefined)).toBe(false);
    expect(isRateLimitError('')).toBe(false);
  });

  test('detects "rate limit"', () => {
    expect(isRateLimitError('rate limit exceeded')).toBe(true);
  });

  test('detects "too many requests"', () => {
    expect(isRateLimitError('too many requests')).toBe(true);
  });

  test('detects 429 status', () => {
    expect(isRateLimitError('HTTP 429 Too Many Requests')).toBe(true);
  });

  test('detects "exceeded your current quota"', () => {
    expect(isRateLimitError('exceeded your current quota')).toBe(true);
  });
});

describe('isBillingError', () => {
  test('detects "payment required"', () => {
    expect(isBillingError('payment required')).toBe(true);
  });

  test('detects HTTP 402', () => {
    expect(isBillingError('http 402 Payment Required')).toBe(true);
  });

  test('detects "insufficient credits"', () => {
    expect(isBillingError('insufficient credits')).toBe(true);
  });
});

describe('isAuthError', () => {
  test('detects "invalid api key"', () => {
    expect(isAuthError('invalid api key provided')).toBe(true);
  });

  test('detects "unauthorized"', () => {
    expect(isAuthError('unauthorized access')).toBe(true);
  });

  test('detects 401', () => {
    expect(isAuthError('HTTP 401 Unauthorized')).toBe(true);
  });

  test('detects 403', () => {
    expect(isAuthError('HTTP 403 Forbidden')).toBe(true);
  });
});

describe('isTimeoutError', () => {
  test('detects "timeout"', () => {
    expect(isTimeoutError('request timeout')).toBe(true);
  });

  test('detects "timed out"', () => {
    expect(isTimeoutError('connection timed out')).toBe(true);
  });

  test('detects "deadline exceeded"', () => {
    expect(isTimeoutError('context deadline exceeded')).toBe(true);
  });
});

describe('isOverloadedError', () => {
  test('detects "overloaded"', () => {
    expect(isOverloadedError('service overloaded')).toBe(true);
  });

  test('detects "service unavailable"', () => {
    expect(isOverloadedError('service unavailable')).toBe(true);
  });

  test('detects overloaded_error type', () => {
    expect(isOverloadedError('{"type": "overloaded_error"}')).toBe(true);
  });
});

describe('classifyError', () => {
  test('returns "unknown" for undefined/empty', () => {
    expect(classifyError(undefined)).toBe('unknown');
    expect(classifyError('')).toBe('unknown');
  });

  test('classifies context overflow', () => {
    expect(classifyError('context length exceeded')).toBe('context_overflow');
  });

  test('classifies rate limit', () => {
    expect(classifyError('rate limit exceeded')).toBe('rate_limit');
  });

  test('classifies billing', () => {
    expect(classifyError('payment required')).toBe('billing');
  });

  test('classifies auth', () => {
    expect(classifyError('invalid api key')).toBe('auth');
  });

  test('classifies timeout', () => {
    expect(classifyError('request timeout')).toBe('timeout');
  });

  test('classifies overloaded', () => {
    expect(classifyError('service overloaded')).toBe('overloaded');
  });

  test('returns "unknown" for unrecognized', () => {
    expect(classifyError('something went wrong')).toBe('unknown');
  });
});

describe('isNonRetryableError', () => {
  test('context overflow is non-retryable', () => {
    expect(isNonRetryableError('context length exceeded')).toBe(true);
  });

  test('billing is non-retryable', () => {
    expect(isNonRetryableError('payment required')).toBe(true);
  });

  test('auth is non-retryable', () => {
    expect(isNonRetryableError('invalid api key')).toBe(true);
  });

  test('rate limit IS retryable', () => {
    expect(isNonRetryableError('rate limit exceeded')).toBe(false);
  });

  test('timeout IS retryable', () => {
    expect(isNonRetryableError('request timeout')).toBe(false);
  });
});

describe('parseApiErrorInfo', () => {
  test('returns null for undefined/empty', () => {
    expect(parseApiErrorInfo(undefined)).toBeNull();
    expect(parseApiErrorInfo('')).toBeNull();
    expect(parseApiErrorInfo('   ')).toBeNull();
  });

  test('returns null for non-JSON', () => {
    expect(parseApiErrorInfo('plain text error')).toBeNull();
  });

  test('parses JSON with error.message', () => {
    const json = JSON.stringify({ error: { type: 'invalid_request', message: 'bad input' } });
    const info = parseApiErrorInfo(json);
    expect(info).not.toBeNull();
    expect(info!.type).toBe('invalid_request');
    expect(info!.message).toBe('bad input');
  });

  test('strips error prefix before parsing', () => {
    const json = `Error: ${JSON.stringify({ error: { message: 'test' } })}`;
    const info = parseApiErrorInfo(json);
    expect(info).not.toBeNull();
    expect(info!.message).toBe('test');
  });

  test('parses HTTP status prefix', () => {
    const json = `429 ${JSON.stringify({ message: 'too many requests' })}`;
    const info = parseApiErrorInfo(json);
    expect(info).not.toBeNull();
    expect(info!.httpCode).toBe(429);
    expect(info!.message).toBe('too many requests');
  });

  test('extracts request_id', () => {
    const json = JSON.stringify({ error: { message: 'fail' }, request_id: 'req-123' });
    const info = parseApiErrorInfo(json);
    expect(info!.requestId).toBe('req-123');
  });
});

describe('formatUserFacingError', () => {
  test('empty string returns generic message', () => {
    expect(formatUserFacingError('   ')).toBe('LLM request failed with an unknown error.');
  });

  test('context overflow returns helpful message', () => {
    const msg = formatUserFacingError('context length exceeded');
    expect(msg).toContain('Context overflow');
    expect(msg).toContain('new conversation');
  });

  test('rate limit includes provider label', () => {
    const msg = formatUserFacingError('rate limit exceeded', 'OpenAI');
    expect(msg).toContain('OpenAI');
    expect(msg).toContain('rate limit');
  });

  test('billing error suggests checking dashboard', () => {
    const msg = formatUserFacingError('payment required');
    expect(msg).toContain('credits');
  });

  test('auth error suggests checking API key', () => {
    const msg = formatUserFacingError('invalid api key');
    expect(msg).toContain('API key');
  });

  test('timeout returns try again message', () => {
    const msg = formatUserFacingError('request timeout');
    expect(msg).toContain('timed out');
  });

  test('overloaded returns try again message', () => {
    const msg = formatUserFacingError('service overloaded');
    expect(msg).toContain('overloaded');
  });

  test('unknown with JSON error extracts message', () => {
    const json = JSON.stringify({ error: { type: 'server_error', message: 'internal failure' } });
    const msg = formatUserFacingError(json);
    expect(msg).toContain('internal failure');
    expect(msg).toContain('server_error');
  });

  test('long unknown errors are truncated', () => {
    const long = 'x'.repeat(500);
    const msg = formatUserFacingError(long);
    expect(msg.length).toBeLessThan(310);
    expect(msg).toContain('...');
  });
});
