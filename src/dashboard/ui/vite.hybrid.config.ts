import { defineConfig } from 'vite';

/**
 * Build the prebuilt hybrid chat chunk (dist-hybrid/hybrid-chat.js).
 *
 * This is the ONLY bundle in the repo that may contain transformers.js /
 * onnxruntime-web. It is a plain library build (no singlefile plugin, no code
 * splitting) so the ort wasm/worker assets never have to fight vite's HTML
 * inlining — they are copied next to the chunk as same-origin static files by
 * scripts/copy-ort-web-assets.ts and served at /assets/ort/.
 *
 * Run: npm run build:hybrid (from src/dashboard/ui)
 */
export default defineConfig({
  resolve: {
    conditions: [
      // Select onnxruntime-web's non-bundled variant (ort.webgpu.min.mjs), so
      // the .wasm binaries are NOT inlined into the chunk as base64. ORT then
      // fetches them at runtime from env.backends.onnx.wasm.wasmPaths — the
      // same-origin /assets/ort/ copies produced by copy-ort-web-assets.ts.
      'onnxruntime-web-use-extern-wasm',
    ],
  },
  build: {
    outDir: 'dist-hybrid',
    emptyOutDir: true,
    target: 'esnext',
    minify: false,
    lib: {
      entry: 'src/hybrid/standalone.ts',
      formats: ['es'],
      fileName: () => 'hybrid-chat.js',
    },
    rollupOptions: {
      output: {
        // Single file, no code-splitting: one chunk the dashboard can serve.
        inlineDynamicImports: true,
      },
    },
  },
});