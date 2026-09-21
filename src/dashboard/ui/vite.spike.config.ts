import { defineConfig } from 'vite';

/**
 * SPIKE HARNESS build (not shipped) — bundles spike/main.ts (which imports
 * transformers.js directly) to spike/dist/spike.js. This is variant (a) of the
 * spike: a plain vite browser build of transformers.js, proving the module
 * bundles for the browser without the singlefile plugin in the way.
 */
export default defineConfig({
  resolve: {
    conditions: [
      // Mirror vite.hybrid.config.ts: extern-wasm variant + same-origin binaries.
      'onnxruntime-web-use-extern-wasm',
    ],
  },
  build: {
    outDir: 'spike/dist',
    emptyOutDir: true,
    target: 'esnext',
    minify: false,
    rollupOptions: {
      input: 'spike/index.html',
      output: {
        entryFileNames: 'spike.js',
        inlineDynamicImports: true,
      },
    },
  },
});