/**
 * SPIKE driver (throwaway) — launches headless Chrome with WebGPU flags,
 * connects over CDP (flat session mode), navigates to the spike page, and
 * polls the results pre#out in REAL time (unlike --dump-dom
 * --virtual-time-budget, which burns through page timers instantly and
 * produces spurious timeouts).
 *
 * Usage: bun spike/drive.ts [url] [realtime-timeout-seconds]
 */
import { spawn } from 'node:child_process';

const url = process.argv[2] ?? 'http://localhost:8999/';
const timeoutS = Number(process.argv[3] ?? '600');

const chrome = spawn(
  'google-chrome',
  [
    '--headless=new',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--enable-unsafe-webgpu',
    '--use-angle=swiftshader',
    '--remote-debugging-port=0',
    'about:blank',
  ],
  { stdio: ['ignore', 'ignore', 'pipe'] },
);

const wsUrl: string = await new Promise((resolve, reject) => {
  let buf = '';
  const timer = setTimeout(() => reject(new Error('no devtools ws url')), 20_000);
  chrome.stderr!.on('data', (d: Buffer) => {
    buf += d.toString();
    const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
    if (m) {
      clearTimeout(timer);
      resolve(m[1]);
    }
  });
});

const ws = new WebSocket(wsUrl);
await new Promise((r, j) => {
  ws.addEventListener('open', r);
  ws.addEventListener('error', j);
});

let id = 0;
const pending = new Map<number, (v: any) => void>();
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(String(ev.data));
  if (typeof msg.id === 'number' && pending.has(msg.id)) {
    pending.get(msg.id)!(msg);
    pending.delete(msg.id);
  }
});

function send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> {
  return new Promise((resolve) => {
    const mid = ++id;
    pending.set(mid, resolve);
    ws.send(JSON.stringify(sessionId ? { id: mid, method, params, sessionId } : { id: mid, method, params }));
  });
}

const { result: targetInfo } = await send('Target.createTarget', { url: 'about:blank' });
const targetId = targetInfo.targetId as string;
const { result: attached } = await send('Target.attachToTarget', { targetId, flatten: true });
const sessionId = attached.sessionId as string;

await send('Page.enable', {}, sessionId);
await send('Runtime.enable', {}, sessionId);
await send('Page.navigate', { url }, sessionId);

const t0 = Date.now();
let lastLines: string[] = [];
let done = false;
while (Date.now() - t0 < timeoutS * 1000 && !done) {
  await new Promise((r) => setTimeout(r, 2000));
  const res = await send(
    'Runtime.evaluate',
    {
      expression: 'document.getElementById("out") ? document.getElementById("out").textContent : ""',
      returnByValue: true,
    },
    sessionId,
  );
  const text: string = res?.result?.result?.value ?? '';
  const newLines = text.split('\n').filter((l) => l && !lastLines.includes(l));
  for (const line of newLines) console.log(line);
  if (newLines.length) lastLines = text.split('\n');
  if (text.includes('done=true')) done = true;
}
chrome.kill();
process.exit(0);