// Human-like input for recorded beats, plus the cursor overlay.
//
// The overlay only DRAWS where the real (CDP-driven) pointer is. It is a pointer arrow, nothing else: no labels, no
// ripples, no highlight boxes. Playwright's input events are trusted, so they work on the hold-to-approve control.

export const CURSOR_INIT_SCRIPT = `(() => {
  if (window.__rigCursor) return; window.__rigCursor = true;
  const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="26" viewBox="0 0 22 26"><path d="M2 1.5v18.2l4.6-4.3 3.2 7.3 3.3-1.5-3.2-7.1h6.4z" fill="#fff" stroke="#111" stroke-width="1.6" stroke-linejoin="round"/></svg>';
  const el = document.createElement('div');
  el.setAttribute('aria-hidden', 'true');
  el.style.cssText = 'position:fixed;left:0;top:0;width:22px;height:26px;pointer-events:none;z-index:2147483647;transform:translate(-100px,-100px);transform-origin:2px 2px;filter:drop-shadow(0 1px 2px rgba(0,0,0,.55));will-change:transform;';
  el.innerHTML = SVG;
  let x = -100, y = -100, down = false;
  const paint = () => { el.style.transform = 'translate(' + x + 'px,' + y + 'px) scale(' + (down ? 0.86 : 1) + ')'; };
  addEventListener('mousemove', (e) => { x = e.clientX; y = e.clientY; paint(); }, true);
  addEventListener('mousedown', () => { down = true; paint(); }, true);
  addEventListener('mouseup', () => { down = false; paint(); }, true);
  // An open modal <dialog> lives in the top layer, above any z-index. Keep the cursor inside the topmost open dialog.
  const home = () => {
    const d = document.querySelectorAll('dialog[open]');
    const host = d.length ? d[d.length - 1] : (document.body || document.documentElement);
    if (host && el.parentNode !== host) host.appendChild(el);
    requestAnimationFrame(home);
  };
  requestAnimationFrame(home);
})();`;

const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

export function humanFor(page) {
  let pos = { x: 760, y: 120 };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function glide(x, y, { ms } = {}) {
    const dist = Math.hypot(x - pos.x, y - pos.y);
    const dur = ms ?? Math.min(1100, 260 + dist * 0.9);
    const steps = Math.max(8, Math.round(dur / 16));
    const from = { ...pos };
    // a slight arc so the path is not a ruler line
    const bend = Math.min(40, dist * 0.08) * (Math.random() > 0.5 ? 1 : -1);
    for (let i = 1; i <= steps; i++) {
      const t = ease(i / steps);
      const nx = from.x + (x - from.x) * t + Math.sin(t * Math.PI) * bend * 0.6;
      const ny = from.y + (y - from.y) * t + Math.sin(t * Math.PI) * bend;
      await page.mouse.move(nx, ny);
      await sleep(dur / steps);
    }
    await page.mouse.move(x, y);
    pos = { x, y };
  }

  /** Bring the target into view and glide to a point inside it. Returns the box. */
  async function moveTo(target, { dx = 0, dy = 0, settle = 120 } = {}) {
    const loc = typeof target === 'string' ? page.locator(target).first() : target;
    await loc.scrollIntoViewIfNeeded({ timeout: 15000 });
    const box = await loc.boundingBox();
    if (!box) throw new Error('moveTo: target has no box');
    const x = box.x + box.width / 2 + dx + (Math.random() - 0.5) * Math.min(10, box.width * 0.2);
    const y = box.y + box.height / 2 + dy + (Math.random() - 0.5) * Math.min(6, box.height * 0.2);
    await glide(x, y);
    await sleep(settle);
    return box;
  }

  async function click(target, { pause = 300, dx = 0, dy = 0 } = {}) {
    await moveTo(target, { dx, dy });
    await page.mouse.down();
    await sleep(70 + Math.random() * 50);
    await page.mouse.up();
    await sleep(pause);
  }

  /** Press and keep holding for `ms`, then release. Used for hold-to-approve. */
  async function hold(target, ms, { onDown, onUp } = {}) {
    await moveTo(target);
    await page.mouse.down();
    await onDown?.();
    await sleep(ms);
    await page.mouse.up();
    await onUp?.();
  }

  async function type(target, text, { delay = 55, pause = 250 } = {}) {
    await click(target, { pause: 120 });
    await page.keyboard.type(text, { delay });
    await sleep(pause);
  }

  async function scroll(dy, { steps = 12, ms = 700 } = {}) {
    for (let i = 0; i < steps; i++) { await page.mouse.wheel(0, dy / steps); await sleep(ms / steps); }
  }

  return { glide, moveTo, click, hold, type, scroll, pause: sleep, get pos() { return pos; } };
}
