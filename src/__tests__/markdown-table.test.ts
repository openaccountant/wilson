import { describe, expect, test } from 'bun:test';
import {
  parseMarkdownTable,
  renderBoxTable,
  transformMarkdownTables,
  transformBold,
  formatResponse,
} from '../utils/markdown-table.js';

describe('parseMarkdownTable', () => {
  test('parses a simple markdown table', () => {
    const table = `| Name | Age |
| --- | --- |
| Alice | 30 |
| Bob | 25 |`;
    const result = parseMarkdownTable(table);
    expect(result).not.toBeNull();
    expect(result!.headers).toEqual(['Name', 'Age']);
    expect(result!.rows).toEqual([['Alice', '30'], ['Bob', '25']]);
  });

  test('returns null for too few lines', () => {
    expect(parseMarkdownTable('single line')).toBeNull();
  });

  test('returns null for no pipe characters', () => {
    expect(parseMarkdownTable('no pipes\nhere either')).toBeNull();
  });

  test('returns null for missing separator line', () => {
    expect(parseMarkdownTable('| A | B |\n| data | data |')).toBeNull();
  });

  test('handles alignment indicators in separator', () => {
    const table = `| Left | Center | Right |
| :--- | :---: | ---: |
| a | b | c |`;
    const result = parseMarkdownTable(table);
    expect(result).not.toBeNull();
    expect(result!.headers).toHaveLength(3);
    expect(result!.rows).toHaveLength(1);
  });
});

describe('renderBoxTable', () => {
  test('produces box-drawing characters', () => {
    const result = renderBoxTable(['A', 'B'], [['1', '2']]);
    expect(result).toContain('\u250c'); // top-left
    expect(result).toContain('\u2518'); // bottom-right
    expect(result).toContain('\u2502'); // vertical
    expect(result).toContain('\u2500'); // horizontal
  });

  test('right-aligns numeric columns', () => {
    const result = renderBoxTable(['Item', 'Cost'], [['Apple', '$5.00'], ['Banana', '$3.00']]);
    // Numeric column ($5.00) should be right-aligned (padStart)
    expect(result).toContain('$5.00');
    expect(result).toContain('$3.00');
  });

  test('handles empty rows', () => {
    const result = renderBoxTable(['Header'], []);
    expect(result).toContain('Header');
  });
});

describe('transformMarkdownTables', () => {
  test('converts markdown table in content to box-drawing', () => {
    const content = `Some text\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\nMore text`;
    const result = transformMarkdownTables(content);
    expect(result).toContain('\u250c');
    expect(result).not.toContain('| --- |');
  });

  test('passes through content without tables', () => {
    const content = 'Hello world\nNo tables here';
    expect(transformMarkdownTables(content)).toBe(content);
  });
});

describe('transformBold', () => {
  test('converts **bold** to ANSI bold', () => {
    const result = transformBold('This is **bold** text');
    expect(result).not.toContain('**');
    expect(result).toContain('bold');
  });

  test('handles multiple bold sections', () => {
    const result = transformBold('**first** and **second**');
    expect(result).not.toContain('**');
  });

  test('passes through text without bold', () => {
    expect(transformBold('no bold here')).toBe('no bold here');
  });
});

describe('formatResponse', () => {
  test('applies both table and bold transforms', () => {
    const content = `**Title**\n\n| Col |\n| --- |\n| val |`;
    const result = formatResponse(content);
    expect(result).not.toContain('**');
    expect(result).toContain('\u250c');
  });
});

describe('parseMarkdownTable — additional edge cases', () => {
  test('parses table without leading/trailing pipes', () => {
    const table = `Name | Age
--- | ---
Alice | 30
Bob | 25`;
    const result = parseMarkdownTable(table);
    expect(result).not.toBeNull();
    expect(result!.headers.length).toBeGreaterThanOrEqual(2);
    expect(result!.rows.length).toBe(2);
  });

  test('parses table with empty cells', () => {
    const table = `| Name | Age | City |
| --- | --- | --- |
| Alice | 30 | |
| | 25 | NYC |`;
    const result = parseMarkdownTable(table);
    expect(result).not.toBeNull();
    expect(result!.rows.length).toBe(2);
  });

  test('parses single-column table', () => {
    const table = `| Item |
| --- |
| Apple |
| Banana |`;
    const result = parseMarkdownTable(table);
    expect(result).not.toBeNull();
    expect(result!.headers).toEqual(['Item']);
    expect(result!.rows.length).toBe(2);
  });
});

describe('transformMarkdownTables — tableRegex2 branch', () => {
  test('transforms tables without leading/trailing pipes', () => {
    const content = `Some text\n\nName | Age\n--- | ---\nAlice | 30\nBob | 25\n\nMore text`;
    const result = transformMarkdownTables(content);
    // Should be transformed to box-drawing characters
    expect(result).toContain('\u250c');
    expect(result).toContain('Alice');
    expect(result).toContain('Bob');
  });

  test('handles table with empty cells via transformMarkdownTables', () => {
    const content = `| A | B |\n| --- | --- |\n| 1 | |\n| | 2 |`;
    const result = transformMarkdownTables(content);
    expect(result).toContain('\u250c');
  });
});
