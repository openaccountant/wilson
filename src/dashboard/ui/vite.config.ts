import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'path';

const WASM_MODULE_ID = 'virtual:wa-sqlite-wasm';

/**
 * Inline the wa-sqlite wasm binary into the bundle as a base64 string so the
 * mirror store needs no runtime fetch, no static-asset route in server.ts, and
 * no COOP/COEP headers (see docs/plans/2026-09-20-003-dashboard-offline-store-
 * comparison.md §5.2/§5.4 — the committed delivery for the offline store).
 */
function waSqliteWasmInline(): Plugin {
  const require = createRequire(import.meta.url);
  const wasmPath = path.join(
    path.dirname(require.resolve('wa-sqlite/package.json')),
    'dist',
    'wa-sqlite.wasm'
  );
  const resolvedId = `\0${WASM_MODULE_ID}`;

  return {
    name: 'wa-sqlite-wasm-inline',
    resolveId(id) {
      if (id === WASM_MODULE_ID) return resolvedId;
    },
    load(id) {
      if (id !== resolvedId) return;
      const base64 = readFileSync(wasmPath).toString('base64');
      return `export default ${JSON.stringify(base64)};`;
    },
    generateBundle(_, bundle) {
      // The emscripten glue still references the wasm path it never fetches
      // (wasmBinary is provided instead); drop the emitted asset so the build
      // truly produces a single index.html.
      for (const name of Object.keys(bundle)) {
        if (name.endsWith('.wasm')) delete bundle[name];
      }
    },
  };
}

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
  plugins: [react(), tailwindcss(), viteSingleFile(), waSqliteWasmInline(), webMcpBridgeDevTag()],
  // The mirror worker imports wa-sqlite's ESM build (which uses import.meta.url),
  // so the inline worker must be bundled as an ES module; the wasm-inline plugin
  // must apply to the worker bundle too (workers are bundled separately at build).
  worker: {
    format: 'es',
    plugins: () => [waSqliteWasmInline()],
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
    },
  },
  server: {
    proxy: {
      // WebMCP grants are bound to the request Origin (deriveScope in
      // src/dashboard/mcp-routes.ts). Present the dashboard's own origin so a
      // grant made through the dev server matches what the same tab's later
      // GETs (which carry no Origin header) resolve to — i.e. dev behaves
      // exactly like `wilson --dashboard`.
      // changeOrigin rewrites Host to the dashboard's own, so /api/prelabel/* passes its Host check
      // (a Host of localhost:5173 is refused as DNS rebinding).
      '/api': { target: DASHBOARD_ORIGIN, changeOrigin: true, headers: { origin: DASHBOARD_ORIGIN } },
      '/mcp': { target: DASHBOARD_ORIGIN, headers: { origin: DASHBOARD_ORIGIN } },
      '/webmcp-bridge.js': DASHBOARD_ORIGIN,
      // Prebuilt hybrid chunk + ort binaries are served by the API server.
      '/assets': DASHBOARD_ORIGIN,
    },
  },
  build: {
    outDir: 'dist',
    target: 'esnext',
  },
});