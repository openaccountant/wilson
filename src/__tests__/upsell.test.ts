import { describe, test, expect, spyOn, beforeEach, afterEach } from 'bun:test';
import * as browser from '../utils/browser.js';
import { getCheckoutUrl, toolUpsell, interactiveUpsell, headlessUpsell } from '../licensing/upsell.js';

describe('licensing/upsell', () => {
  let savedUrl: string | undefined;
  let savedMonthly: string | undefined;
  let savedAnnual: string | undefined;

  beforeEach(() => {
    savedUrl = process.env.OA_CHECKOUT_URL;
    savedMonthly = process.env.OA_CHECKOUT_MONTHLY;
    savedAnnual = process.env.OA_CHECKOUT_ANNUAL;
    delete process.env.OA_CHECKOUT_URL;
    delete process.env.OA_CHECKOUT_MONTHLY;
    delete process.env.OA_CHECKOUT_ANNUAL;
  });

  afterEach(() => {
    if (savedUrl !== undefined) process.env.OA_CHECKOUT_URL = savedUrl;
    else delete process.env.OA_CHECKOUT_URL;
    if (savedMonthly !== undefined) process.env.OA_CHECKOUT_MONTHLY = savedMonthly;
    else delete process.env.OA_CHECKOUT_MONTHLY;
    if (savedAnnual !== undefined) process.env.OA_CHECKOUT_ANNUAL = savedAnnual;
    else delete process.env.OA_CHECKOUT_ANNUAL;
  });

  describe('getCheckoutUrl', () => {
    test('returns default annual URL', () => {
      const url = getCheckoutUrl('annual');
      expect(url).toBe('https://openaccountant.ai/buy');
    });

    test('returns default monthly URL', () => {
      const url = getCheckoutUrl('monthly');
      expect(url).toBe('https://openaccountant.ai/buy/monthly');
    });

    test('defaults to annual when no arg', () => {
      const url = getCheckoutUrl();
      expect(url).toBe('https://openaccountant.ai/buy');
    });

    test('respects OA_CHECKOUT_URL override for annual', () => {
      process.env.OA_CHECKOUT_URL = 'https://custom.example.com/buy';
      const url = getCheckoutUrl('annual');
      expect(url).toBe('https://custom.example.com/buy');
    });

    test('respects OA_CHECKOUT_URL override for monthly', () => {
      process.env.OA_CHECKOUT_URL = 'https://custom.example.com/buy';
      const url = getCheckoutUrl('monthly');
      expect(url).toBe('https://custom.example.com/buy');
    });

    test('respects OA_CHECKOUT_MONTHLY override', () => {
      process.env.OA_CHECKOUT_MONTHLY = 'https://custom.example.com/monthly';
      const url = getCheckoutUrl('monthly');
      expect(url).toBe('https://custom.example.com/monthly');
    });

    test('respects OA_CHECKOUT_ANNUAL override', () => {
      process.env.OA_CHECKOUT_ANNUAL = 'https://custom.example.com/annual';
      const url = getCheckoutUrl('annual');
      expect(url).toBe('https://custom.example.com/annual');
    });
  });

  describe('toolUpsell', () => {
    test('returns JSON with error and upgradeUrl', () => {
      const result = toolUpsell('Tax Tracking');
      const parsed = JSON.parse(result);
      expect(parsed.data.error).toContain('Tax Tracking');
      expect(parsed.data.error).toContain('Pro feature');
      expect(parsed.data.upgradeUrl).toBe('https://openaccountant.ai/buy');
      expect(parsed.data.message).toContain('$99/yr');
    });
  });

  describe('interactiveUpsell', () => {
    let browserSpy: ReturnType<typeof spyOn>;

    beforeEach(() => {
      browserSpy = spyOn(browser, 'openBrowser').mockReturnValue(true);
    });

    afterEach(() => {
      browserSpy?.mockRestore();
    });

    test('calls openBrowser and returns formatted message', () => {
      const result = interactiveUpsell('Plaid Sync');
      expect(browserSpy).toHaveBeenCalledWith('https://openaccountant.ai/buy');
      expect(result).toContain('Plaid Sync');
      expect(result).toContain('Pro feature');
      expect(result).toContain('/upgrade');
    });

    test('includes preview when provided', () => {
      const result = interactiveUpsell('Tax Tracking', 'Preview: tax summary table');
      expect(result).toContain('Preview: tax summary table');
      expect(result).toContain('Tax Tracking');
    });

    test('omits preview when not provided', () => {
      const result = interactiveUpsell('Plaid Sync');
      expect(result).not.toContain('Preview');
    });
  });

  describe('headlessUpsell', () => {
    test('prints to stderr and exits', () => {
      const stderrSpy = spyOn(console, 'error').mockImplementation(() => {});
      const exitSpy = spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('process.exit called');
      });

      try {
        headlessUpsell('Monarch Import');
      } catch (e: any) {
        expect(e.message).toBe('process.exit called');
      }

      expect(stderrSpy).toHaveBeenCalled();
      const msg = stderrSpy.mock.calls[0][0] as string;
      expect(msg).toContain('Monarch Import');
      expect(msg).toContain('Pro');

      stderrSpy.mockRestore();
      exitSpy.mockRestore();
    });
  });
});
