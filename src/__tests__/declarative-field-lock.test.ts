import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ALLOWED_READONLY_INPUTS, FIELD_LOCK_CLASS, fieldLock } from '../dashboard/declarative-submit-core.js';

/**
 * S1: Chrome re-derives a declarative tool's schema from the form DOM whenever it changes and CANCELS the call in flight
 * ("Tool execution cancelled, since tool definition was updated"). `disabled` and `readonly` fields are OMITTED from that
 * schema, so a field that toggles either while a call runs changes the tool definition mid-call. A field of a declarative
 * form is locked while busy in a way the schema does not see: `aria-disabled`, a CSS class on the wrapper, and a handler
 * that ignores human changes.
 */

describe('fieldLock (the schema-neutral lock)', () => {
  test('unlocked: nothing is added', () => {
    const lock = fieldLock(false);
    expect(lock.wrapperClass).toBe('');
    expect(lock.fieldProps).toEqual({});
  });

  test('locked: aria-disabled and the wrapper class, never disabled or readOnly', () => {
    const lock = fieldLock(true);
    expect(lock.wrapperClass).toBe(FIELD_LOCK_CLASS);
    expect(lock.fieldProps).toEqual({ 'aria-disabled': 'true' });
    expect(Object.keys(lock.fieldProps)).not.toContain('disabled');
    expect(Object.keys(lock.fieldProps)).not.toContain('readOnly');
  });

  test('guard: a human change while locked is ignored; unlocked it goes through', () => {
    const seen: string[] = [];
    const locked = fieldLock(true).guard((v: string) => seen.push(v));
    locked('typed while saving');
    expect(seen).toEqual([]);
    const open = fieldLock(false).guard((v: string) => seen.push(v));
    open('typed');
    expect(seen).toEqual(['typed']);
  });
});

// ── Source guards ────────────────────────────────────────────────────────────

const uiRoot = join(import.meta.dir, '../dashboard/ui/src');
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : /\.(tsx|ts)$/.test(name) ? [full] : [];
  });
const strip = (code: string) => code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
/** Every file that wires a declarative form (the hook itself excluded). */
const formFiles = walk(uiRoot).filter((f) => /useDeclarativeTool\(\{/.test(readFileSync(f, 'utf8')) && !f.endsWith('useDeclarativeTool.ts'));
const rel = (f: string) => f.slice(uiRoot.length + 1);

interface El {
  tag: string;
  /** The opening tag, source text. */
  open: string;
  /** From the opening tag to the matching close (a `select` / `textarea`) or just the opening tag. */
  text: string;
}

/** Opening tags of `<input>`, `<select>` and `<textarea>`, scanned with brace and quote awareness (`=>` is not a tag end). */
function fieldElements(code: string): El[] {
  const out: El[] = [];
  const re = /<(input|select|textarea)\b/g;
  for (let m = re.exec(code); m; m = re.exec(code)) {
    let i = m.index + m[0].length;
    let depth = 0;
    let quote: string | null = null;
    for (; i < code.length; i++) {
      const c = code[i];
      if (quote) {
        if (c === quote) quote = null;
      } else if (c === '"' || c === "'" || (c === '`' && depth > 0)) quote = c;
      else if (c === '{') depth++;
      else if (c === '}') depth--;
      else if (c === '>' && depth === 0 && code[i - 1] !== '=') break;
    }
    const open = code.slice(m.index, i + 1);
    const closeTag = `</${m[1]}>`;
    const closeAt = m[1] === 'input' ? -1 : code.indexOf(closeTag, i);
    out.push({ tag: m[1], open, text: closeAt === -1 ? open : code.slice(m.index, closeAt + closeTag.length) });
  }
  return out;
}

/** A field of a declarative form: it spreads `<x>.field(...)` or the `extraProps` a form hands to a shared number field. */
const isToolField = (el: El) => /\{\.\.\.[\w.]*\.field\(/.test(el.open) || /\{\.\.\.extraProps\}/.test(el.open);
const nameOf = (el: El) => /\bname=["']([\w-]+)["']/.exec(el.open)?.[1];
const allowedReadonly = new Set(Object.values(ALLOWED_READONLY_INPUTS).flat());
/** The tag with its quoted strings removed, so a class name like "disabled:opacity-50" is not mistaken for an attribute. */
const bare = (open: string) => open.replace(/"[^"]*"|'[^']*'|`[^`]*`/g, '""');

describe('S1 source guards: fields of a declarative form are never disabled or readOnly', () => {
  test('there are declarative form files and fields to guard (the scanner finds them)', () => {
    expect(formFiles.length).toBeGreaterThanOrEqual(5);
    const counts = Object.fromEntries(formFiles.map((f) => [rel(f), fieldElements(strip(readFileSync(f, 'utf8'))).filter(isToolField).length]));
    for (const f of ['tabs/GoalsTab.tsx', 'tabs/ReviewTab.tsx', 'tabs/TransactionsTab.tsx', 'components/ManualInputsForm.tsx', 'components/judge/JudgeInteractionForm.tsx']) {
      expect(counts[f], f).toBeGreaterThan(0);
    }
    expect(counts['tabs/GoalsTab.tsx']).toBe(6);
    expect(counts['tabs/ReviewTab.tsx']).toBe(3);
  });

  test('no element that spreads declarative.field(...) carries disabled= / readOnly / readonly (a static read-only identity field on the allow-list excepted)', () => {
    for (const file of formFiles) {
      for (const el of fieldElements(strip(readFileSync(file, 'utf8'))).filter(isToolField)) {
        const attrs = bare(el.open);
        expect(/\bdisabled\b/.test(attrs), `${rel(file)}: <${el.tag} name=${nameOf(el)}> carries disabled`).toBe(false);
        if (/\b(readOnly|readonly)\b/.test(attrs)) {
          // Chrome omits a readonly field from the schema, so only a field that is ALWAYS read-only (never toggled) and listed,
          // with the reason, in ALLOWED_READONLY_INPUTS may carry it.
          expect(/\breadOnly\s*=\s*\{/.test(attrs), `${rel(file)}: readOnly of ${nameOf(el)} must be a static attribute, not toggled`).toBe(false);
          const name = nameOf(el);
          expect(name !== undefined && allowedReadonly.has(name), `${rel(file)}: readOnly input ${name} is not on the allow-list`).toBe(true);
        }
      }
    }
  });

  test('every type="number" input of a declarative form file has step="any" (the schema must not depend on the value)', () => {
    for (const file of formFiles) {
      const numbers = fieldElements(strip(readFileSync(file, 'utf8'))).filter((el) => el.tag === 'input' && /\btype=["']number["']/.test(el.open));
      for (const el of numbers) expect(el.open, `${rel(file)}: number input ${nameOf(el)}`).toContain('step="any"');
    }
  });

  test('a select of a declarative form lists its options from a held array (or a constant), never straight from props or state', () => {
    for (const file of formFiles) {
      const code = strip(readFileSync(file, 'utf8'));
      const held = new Set([...code.matchAll(/\bconst\s+(\w+)\s*=\s*\w+\.hold\(/g)].map((m) => m[1]));
      const constants = new Set([...code.matchAll(/^const\s+([A-Z][A-Z0-9_]*)\b/gm)].map((m) => m[1]));
      for (const el of fieldElements(code).filter((e) => e.tag === 'select' && isToolField(e))) {
        for (const m of el.text.matchAll(/(\[[^\]]*\]|\w+)\.map\(/g)) {
          const source = m[1];
          const ok = source.startsWith('[') || held.has(source) || constants.has(source);
          expect(ok, `${rel(file)}: <select name=${nameOf(el)}> maps over ${source}, which is not a held array`).toBe(true);
        }
      }
    }
  });
});

describe('S1: the forms with their own busy state lock their fields without touching the schema', () => {
  const read = (rel: string) => strip(readFileSync(join(uiRoot, rel), 'utf8'));

  for (const file of ['tabs/GoalsTab.tsx', 'tabs/ReviewTab.tsx']) {
    test(`${file}: every field carries the lock's aria-disabled, sits in a wrapper with its class, and ignores human changes while busy`, () => {
      const code = read(file);
      const fields = fieldElements(code).filter(isToolField);
      expect(fields.length).toBeGreaterThan(0);
      for (const el of fields) {
        expect(el.open, `${nameOf(el)}`).toContain('{...lock.fieldProps}');
        expect(el.open, `${nameOf(el)}`).toMatch(/onChange=\{lock\.guard\(/);
      }
      // One wrapper class per field (each field sits in its own label).
      expect((code.match(/lock\.wrapperClass/g) ?? []).length).toBeGreaterThanOrEqual(fields.length);
      expect(code).toMatch(/fieldLock\(busy\)/);
    });
  }

  test('the lock class dims the wrapper and blocks the pointer; it is a class, so the schema does not see it', () => {
    const css = readFileSync(join(uiRoot, 'styles/app.css'), 'utf8');
    const rule = new RegExp(`\\.${FIELD_LOCK_CLASS}\\b[^{]*\\{([^}]*)\\}`).exec(css);
    expect(rule, `app.css has no .${FIELD_LOCK_CLASS} rule`).not.toBeNull();
    expect(rule![1]).toMatch(/opacity:\s*0?\.\d+/);
    expect(rule![1]).toMatch(/pointer-events:\s*none/);
  });

  test('no field class string relies on :disabled styling any more (nothing is disabled to style)', () => {
    for (const file of ['tabs/GoalsTab.tsx']) expect(read(file)).not.toMatch(/FIELD_CLASS =\s*'[^']*disabled:/);
  });
});
