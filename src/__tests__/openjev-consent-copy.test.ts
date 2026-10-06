import { describe, expect, test } from 'bun:test';
import { CONSENT_BUTTON_LABEL, downloadOnceCopy } from '../dashboard/ui/src/openjev/consent-copy.js';

describe('Download-once consent copy', () => {
  const copy = downloadOnceCopy('334 MB');
  test('keeps the original promises', () => {
    expect(copy).toContain('about 334 MB from huggingface.co');
    expect(copy).toContain('pinned model version');
    expect(copy).toContain('Transaction text never leaves this machine');
    expect(copy).toContain('about 1 KB of version checks');
    expect(CONSENT_BUTTON_LABEL).toBe('Download once');
  });
  test('says the same model may also pick lookups for chat questions', () => {
    expect(copy).toMatch(/same model also helps pick which lookup answers a chat question/);
    expect(copy).toContain('reuses this download');
  });
});
