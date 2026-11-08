import { describe, expect, test } from 'bun:test';
import { TOOLTIP_CLOSED, placeTooltip, tooltipOpen, tooltipReduce, type TooltipEvent } from '../dashboard/ui/src/lib/tooltipState.js';

// The chip uses the UI's '@/' alias and the UI's own React copy, neither of
// which the root tsconfig resolves; load them untyped through a computed path.
const ui = '../dashboard/ui/';
const { createElement } = await import(ui + 'node_modules/react/index.js');
const { renderToStaticMarkup } = await import(ui + 'node_modules/react-dom/server.js');
const { PrelabelChip, PRELABEL_CHIP_TOOLTIP } = await import(ui + 'src/components/prelabel/PrelabelChip.tsx');

const run = (...events: TooltipEvent[]) => events.reduce(tooltipReduce, TOOLTIP_CLOSED);

describe('tooltipState', () => {
  test('hover and focus each open it; it stays open until both are gone', () => {
    expect(tooltipOpen(run('hover-in'))).toBe(true);
    expect(tooltipOpen(run('focus'))).toBe(true);
    expect(tooltipOpen(run('focus', 'hover-in', 'hover-out'))).toBe(true);
    expect(tooltipOpen(run('focus', 'hover-in', 'hover-out', 'blur'))).toBe(false);
  });

  test('Escape dismisses even while hovered and focused', () => {
    expect(tooltipOpen(run('hover-in', 'focus', 'escape'))).toBe(false);
  });

  test('tap toggles on touch; blur and outside press close it', () => {
    expect(tooltipOpen(run('tap'))).toBe(true);
    expect(tooltipOpen(run('tap', 'tap'))).toBe(false);
    expect(tooltipOpen(run('tap', 'blur'))).toBe(false);
    expect(tooltipOpen(run('tap', 'outside'))).toBe(false);
  });

  test('a second tap closes it even if the tap also focused the trigger', () => {
    expect(tooltipOpen(run('tap', 'focus', 'tap'))).toBe(false);
    expect(tooltipOpen(run('focus', 'tap'))).toBe(false);
    expect(tooltipOpen(run('tap', 'tap', 'tap'))).toBe(true);
  });
});

describe('placeTooltip', () => {
  const vp = { width: 1000, height: 700 };
  const bubble = { width: 256, height: 60 };
  const trig = (left: number, top: number) => ({ left, right: left + 100, top, bottom: top + 20 });

  test('sits 6px below, centred, when there is room', () => {
    const p = placeTooltip(trig(400, 100), bubble, vp);
    expect(p).toEqual({ left: 450 - 128, top: 126, side: 'below' });
  });

  test('flips above when it does not fit below', () => {
    const p = placeTooltip(trig(400, 660), bubble, vp);
    expect(p.side).toBe('above');
    expect(p.top).toBe(660 - 6 - 60);
  });

  test('clamps horizontally inside the viewport', () => {
    expect(placeTooltip(trig(0, 100), bubble, vp).left).toBe(8);
    expect(placeTooltip(trig(950, 100), bubble, vp).left).toBe(1000 - 256 - 8);
  });

  test('stays inside the viewport when neither side fits', () => {
    const p = placeTooltip(trig(400, 20), { width: 256, height: 690 }, vp);
    expect(p.top).toBeGreaterThanOrEqual(8);
    expect(p.top + 690).toBeLessThanOrEqual(700);
  });
});

describe('PrelabelChip tooltip (#208)', () => {
  const html = renderToStaticMarkup(createElement(PrelabelChip, { route: { kind: 'agrees', chip: 'JEV AGREES 62%' } }));

  test('no native title attribute', () => {
    expect(html).not.toMatch(/\stitle=/);
  });

  test('chip is focusable and described by the tooltip element', () => {
    expect(html).toContain('tabindex="0"');
    const describedBy = html.match(/aria-describedby="([^"]+)"/)?.[1];
    expect(describedBy).toBeTruthy();
    expect(html).toContain(`id="${describedBy}"`);
    expect(html).toContain('role="tooltip"');
  });

  test('keeps the explanation text, closed by default', () => {
    expect(html).toContain("open-jev&#x27;s margin between its top two choices, not the LLM&#x27;s confidence");
    expect(html).toMatch(/role="tooltip"[^>]*hidden|hidden=""[^>]*role="tooltip"/);
    expect(PRELABEL_CHIP_TOOLTIP).toContain('nothing is applied until you click');
  });
});
