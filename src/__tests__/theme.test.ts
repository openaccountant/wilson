import { describe, test, expect } from 'bun:test';
import { theme, markdownTheme, selectListTheme, editorTheme } from '../theme.js';

describe('theme', () => {
  describe('foreground color functions', () => {
    const fgFunctions = [
      'primary',
      'primaryLight',
      'success',
      'error',
      'warning',
      'muted',
      'mutedDark',
      'accent',
      'white',
      'info',
      'border',
    ] as const;

    for (const name of fgFunctions) {
      test(`${name} returns a styled string`, () => {
        const result = theme[name]('hello');
        expect(typeof result).toBe('string');
        expect(result.length).toBeGreaterThan(0);
      });
    }
  });

  describe('background color functions', () => {
    test('queryBg returns a styled string', () => {
      const result = theme.queryBg('hello');
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    });
  });

  describe('utility functions', () => {
    test('dim returns a string', () => {
      const result = theme.dim('dimmed');
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    });

    test('bold returns a string', () => {
      const result = theme.bold('bolded');
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    });

    test('separator returns a string of box-drawing characters', () => {
      const result = theme.separator();
      expect(result).toContain('\u2500');
    });

    test('separator respects custom width', () => {
      const result40 = theme.separator(40);
      const result80 = theme.separator(80);
      // The 40-width separator should be shorter than 80-width
      expect(result40.length).toBeLessThan(result80.length);
    });
  });
});

describe('markdownTheme', () => {
  const themeFunctions = [
    'heading',
    'link',
    'linkUrl',
    'code',
    'codeBlock',
    'codeBlockBorder',
    'quote',
    'quoteBorder',
    'hr',
    'listBullet',
    'bold',
    'italic',
    'strikethrough',
    'underline',
  ] as const;

  for (const name of themeFunctions) {
    test(`${name} returns a styled string`, () => {
      const result = markdownTheme[name]('test');
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    });
  }
});

describe('selectListTheme', () => {
  const themeFunctions = [
    'selectedPrefix',
    'selectedText',
    'description',
    'scrollInfo',
    'noMatch',
  ] as const;

  for (const name of themeFunctions) {
    test(`${name} returns a styled string`, () => {
      const result = selectListTheme[name]('test');
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    });
  }
});

describe('editorTheme', () => {
  test('borderColor returns a styled string', () => {
    const result = editorTheme.borderColor('test');
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  test('selectList is the selectListTheme', () => {
    expect(editorTheme.selectList).toBe(selectListTheme);
  });
});
