/**
 * SPIKE throwaway static server — mirrors the dashboard's /assets/* layout:
 *   /                → spike/dist/index.html (+ spike.js)
 *   /assets/hybrid-chat.js → the prebuilt hybrid chunk (dist-hybrid/)
 *   /assets/ort/*    → same-origin onnxruntime-web binaries
 */
import { serve } from 'bun';

const root = new URL('.', import.meta.url).pathname; // src/dashboard/ui/spike
const ui = new URL('../', import.meta.url).pathname; // src/dashboard/ui
const repo = new URL('../../../../', import.meta.url).pathname; // repo root (spike → ui → dashboard → src → repo)

const mime: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
};

const server = serve({
  port: 8999,
  async fetch(req) {
    const path = new URL(req.url).pathname;
    const serveFile = (fsPath: string): Response => {
      const file = Bun.file(fsPath);
      if (!file.exists) return new Response('Not Found', { status: 404 });
      const ext = fsPath.slice(fsPath.lastIndexOf('.'));
      return new Response(file, { headers: { 'Content-Type': mime[ext] ?? 'application/octet-stream' } });
    };
    if (path === '/' || path === '/index.html') return serveFile(root + 'dist/spike/index.html');
    if (path === '/spike.js') return serveFile(root + 'dist/spike.js');
    if (path === '/assets/hybrid-chat.js') return serveFile(ui + 'dist-hybrid/hybrid-chat.js');
    if (path.startsWith('/assets/ort/')) {
      return serveFile(repo + 'node_modules/onnxruntime-web/dist/' + path.slice('/assets/ort/'.length));
    }
    return new Response('Not Found', { status: 404 });
  },
});

console.log(`spike server on http://localhost:${server.port}`);