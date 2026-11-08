import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';

/**
 * Where the content-hashed build output lives, under dist/ and in URLs (/_app/<name>-<hash>.<ext>).
 * src/dashboard/server.ts serves this directory with immutable caching (DASHBOARD_APP_PREFIX); keep the
 * two in step. Not /assets/: that prefix belongs to the unhashed hybrid build (dist-hybrid).
 */
const APP_ASSETS_DIR = '_app';

/**
 * In production the dashboard server injects the WebMCP bridge <script> into
 * the HTML it serves (injectWebMcpBridge in src/dashboard/server.ts). The dev
 * server serves index.html itself, so inject the same tag here — otherwise
 * `bun run dev` has no Agent access panel and no confirmation cards at all.
 */
function webMcpBridgeDevTag(): Plugin {
  return {
    name: 'webmcp-bridge-dev-tag',
    apply: 'serve',
    transformIndexHtml() {
      return [{ tag: 'script', attrs: { src: '/webmcp-bridge.js', defer: true }, injectTo: 'body' }];
    },
  };
}

const DASHBOARD_ORIGIN = 'http://localhost:3141';

export default defineConfig({
  plugins: [react(), tailwindcss(), webMcpBridgeDevTag()],
  // The mirror worker imports wa-sqlite's ESM build (which uses import.meta.url),
  // so it is bundled as an ES module worker (its own hashed file under /_app/).
  worker: {
    format: 'es',
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      // Browser-safe statement-import helpers shared with the CLI
      // (src/tools/import/client-import.ts + parsers it pulls in).
      '@import-tools': path.resolve(__dirname, '../../tools/import'),
      // Shared WebMCP gate constants (session key, panel-open event) so the
      // React build and the in-page bridge can't drift apart.
      '@webmcp-session': path.resolve(__dirname, '../../dashboard/webmcp-session'),
      // What the one-time client-token reveal may render (pure model, tested from the root).
      '@webmcp-token-reveal': path.resolve(__dirname, '../../dashboard/webmcp-token-reveal'),
      // The agent-access view-model and the confirmation card's content model: the same files the in-page bridge
      // bundles, so Settings and the floating panel render one set of rules.
      '@agent-access-model': path.resolve(__dirname, '../../dashboard/agent-access-model'),
      '@confirmation-card': path.resolve(__dirname, '../../mcp/confirmation-card'),
      // Which agent tools are live right now (published by the in-page bridge, read by the declarative forms),
      // and the pure submit routing, argument coercion and option builders those forms share with root tests.
      '@webmcp-registry': path.resolve(__dirname, '../../dashboard/webmcp-page-registry'),
      '@declarative-submit': path.resolve(__dirname, '../../dashboard/declarative-submit-core'),
      // What `get_page_context` and `open_tab` answer (pure, tested from the root), registered by WebMcpProvider.
      '@webmcp-page-tools': path.resolve(__dirname, '../../dashboard/webmcp-page-tools-core'),
      // The Training tab's judge rules: the blind rule for an agent-opened panel, the queue's text and limits,
      // and the export opt-ins (pure, tested from the root).
      '@judge-ui': path.resolve(__dirname, '../../dashboard/judge-ui-core'),
    },
  },
  server: {
    // Vite's default `cors` reflects ANY localhost/127.0.0.1/[::1] origin on any port, and its middleware runs
    // before the proxy, so a page on http://localhost:8080 could read GET /api/* through :5173 (the dashboard
    // sends no ACAO of its own for a foreign Origin, so Vite's header would survive). The dev page is
    // same-origin with this server and needs no CORS at all.
    cors: false,
    // Only loopback names may address the dev server (DNS-rebinding guard); this mirrors the dashboard's Host check.
    allowedHosts: ['localhost', '127.0.0.1', '[::1]'],
    proxy: {
      // Same-origin dev: src/dashboard/ui/src/api.ts calls relative URLs, so the browser
      // treats :5173 as one origin and sends its own Origin / Sec-Fetch-Site untouched.
      // This proxy used to REWRITE Origin to the dashboard's (`headers: { origin }`), which
      // made every proxied request look same-origin to the server, including one from
      // another site that could reach :5173. Origin now passes through and the server
      // judges it (src/dashboard/origin-gate.ts).
      //
      // `changeOrigin: true` rewrites only Host, to the dashboard's `localhost:3141`, so the
      // request passes the server's Host check (a Host of localhost:5173 is refused as DNS
      // rebinding). The dashboard server must run with `WILSON_DASHBOARD_DEV=1`, which adds
      // :5173 to its Origin allowlist; grants made from here are bound to the canonical
      // `http://localhost:3141`, the same origin the `wilson --dashboard` page has.
      '/api': { target: DASHBOARD_ORIGIN, changeOrigin: true },
      '/mcp': { target: DASHBOARD_ORIGIN, changeOrigin: true },
      '/webmcp-bridge.js': { target: DASHBOARD_ORIGIN, changeOrigin: true },
      // Prebuilt hybrid chunk + ort binaries are served by the API server.
      '/assets': { target: DASHBOARD_ORIGIN, changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    target: 'esnext',
    // The page is index.html plus hashed files under /_app/: the server sends the HTML no-cache and
    // everything under /_app/ immutable, so a phone downloads and compiles the app once per release
    // and the first paint waits only for the entry chunk (tabs and heavy libraries load on demand).
    assetsDir: APP_ASSETS_DIR,
    // Never base64 a file into the JS: an inlined asset can't be cached on its own.
    assetsInlineLimit: 0,
    rollupOptions: {
      output: {
        // Stable vendor chunks: an app-code change doesn't invalidate the cached React runtime.
        manualChunks(id) {
          if (/node_modules\/(react|react-dom|scheduler)\//.test(id)) return 'react';
          return undefined;
        },
      },
    },
  },
});