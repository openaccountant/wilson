import { defineConfig } from 'vite';

/**
 * Build the open-jev pre-labeler worker (dist-hybrid/prelabel-worker.js).
 *
 * Like vite.hybrid.config.ts this is a plain library build that may contain
 * transformers.js / onnxruntime-web / open-jev, and must NEVER be imported by
 * the singlefile React bundle (scripts/check-prelabel-bundle.ts enforces it).
 *
 * It MUST run after the hybrid build: that config uses emptyOutDir:true and
 * would delete this file. Hence `emptyOutDir: false` here and the ordering in
 * package.json `build:hybrid`.
 *
 * Entry path is the BROWSER src/prelabel/worker.ts under src/dashboard/ui/,
 * not the server-side /src/prelabel/ (specs/open-jev-labeler.md §10.3).
 *
 * Run: npm run build:hybrid (from src/dashboard/ui)
 */
export default defineConfig({
  resolve: {
    conditions: [
      // Same as vite.hybrid.config.ts: keep onnxruntime-web's .wasm out of the
      // chunk; ORT fetches them from env.backends.onnx.wasm.wasmPaths
      // (same-origin /assets/ort/, copied by scripts/copy-ort-web-assets.ts).
      'onnxruntime-web-use-extern-wasm',
    ],
  },
  build: {
    outDir: 'dist-hybrid',
    emptyOutDir: false,
    target: 'esnext',
    minify: false,
    lib: {
      entry: 'src/prelabel/worker.ts',
      formats: ['es'],
      fileName: () => 'prelabel-worker.js',
    },
    rollupOptions: {
      output: {
        // Single file, no code-splitting: one worker script the server can serve.
        inlineDynamicImports: true,
      },
    },
  },
});
