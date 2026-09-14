// Render Forensic-Noir title/end cards as PNGs via headless Chrome (no ffmpeg
// drawtext needed). Usage:
//   bun demos/scripts/make-cards.mjs "<title>" "<subtitle>" <out.png> [kind]
// kind: "title" (green title) or "end" (end card). Defaults to title.
import { chromium } from 'playwright';

const [title = '', subtitle = '', out = 'card.png', kind = 'title'] = process.argv.slice(2);
const W = 1400, H = 860;

const titleColor = kind === 'end' ? '#22c55e' : '#22c55e';
const html = `<!doctype html><html><head><meta charset="utf-8">
<style>
  html,body{margin:0;width:${W}px;height:${H}px;background:#0a0f1a;overflow:hidden;}
  .wrap{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;
        font-family:-apple-system,'Helvetica Neue',Arial,sans-serif;}
  .mark{color:#22c55e;font-family:'JetBrains Mono',Menlo,monospace;font-size:34px;font-weight:700;margin-bottom:34px;letter-spacing:1px;}
  .title{color:${titleColor};font-size:64px;font-weight:700;letter-spacing:0.5px;text-align:center;padding:0 60px;line-height:1.1;}
  .sub{color:#9ca3af;font-size:26px;margin-top:26px;font-family:'JetBrains Mono',Menlo,monospace;text-align:center;}
  .rule{width:120px;height:3px;background:#22c55e;margin-top:34px;border-radius:2px;opacity:.8;}
</style></head><body>
  <div class="wrap">
    <div class="mark">$ OPEN ACCOUNTANT</div>
    <div class="title">${title.replace(/</g,'&lt;')}</div>
    ${subtitle ? `<div class="sub">${subtitle.replace(/</g,'&lt;')}</div>` : ''}
    <div class="rule"></div>
  </div>
</body></html>`;

const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: W, height: H } });
await page.setContent(html, { waitUntil: 'networkidle' });
await page.screenshot({ path: out });
await browser.close();
console.log(`card -> ${out}`);
