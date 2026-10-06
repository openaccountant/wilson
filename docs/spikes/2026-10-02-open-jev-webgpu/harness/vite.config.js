import { defineConfig } from 'vite';
import { createReadStream, statSync, existsSync } from 'node:fs';
import { resolve, normalize, sep } from 'node:path';

// The demo is a plain static page; vite is here for the dev server, the ESM
// resolution of @huggingface/transformers, and the COOP/COEP headers that
// onnxruntime-web wants for its threaded wasm fallback.

// ---------------------------------------------------------------------------
// /local-models/ -- serve ONNX weights from this origin instead of the Hub.
//
// WHY. The C-web leg (demo/c-web.mjs) has to run the SAME artifact C-node ran.
// C-node's bytes are already on disk in the transformers.js Node cache
// (node_modules/@huggingface/transformers/.cache/<org>/<repo>/...), 2.8 GB of
// them. Pointing the browser at the Hub instead would (a) re-download all of it
// into a browser profile, and (b) leave open the question of whether the two
// legs even read the same file. Serving the staged directory removes both.
//
// The staging directory is .playwright/models/, built by c-web.mjs: symlinks
// into the transformers.js cache for everything it already holds, plus real
// downloads for the q8 (`model_quantized`) files that cache does not have
// because C-node never ran the wasm rung.
//
// This is a DEV-SERVER-ONLY read path over a directory of model weights. It
// resolves and then re-checks containment, so a `..` in the URL cannot escape.
// Range requests are honoured because onnxruntime-web's external-data loader
// asks for them on large `.onnx_data` files.
// ---------------------------------------------------------------------------
const MODEL_ROOT = resolve(import.meta.dirname, '.playwright/models');
const MIME = {
  '.json': 'application/json',
  '.onnx': 'application/octet-stream',
  '.onnx_data': 'application/octet-stream',
  '.txt': 'text/plain',
  '.model': 'application/octet-stream',
};

function localModels() {
  const middleware = (req, res, next) => {
    if (!req.url || !req.url.startsWith('/local-models/')) return next();
    const rel = decodeURIComponent(req.url.slice('/local-models/'.length).split('?')[0]);
    const abs = resolve(MODEL_ROOT, normalize(rel));
    if (abs !== MODEL_ROOT && !abs.startsWith(MODEL_ROOT + sep)) {
      res.statusCode = 403;
      return res.end('outside model root');
    }
    if (!existsSync(abs)) {
      res.statusCode = 404;
      return res.end('not found');
    }
    const st = statSync(abs); // follows symlinks, which is the point
    if (!st.isFile()) {
      res.statusCode = 404;
      return res.end('not a file');
    }
    const ext = Object.keys(MIME).find((e) => abs.endsWith(e));
    const type = ext ? MIME[ext] : 'application/octet-stream';
    // COEP:require-corp is set on the page; same-origin subresources still need
    // a CORP header once the document is cross-origin-isolated.
    const base = {
      'Content-Type': type,
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store', // a gate re-reads the file, it does not re-read a cache
    };
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
    if (range) {
      const start = range[1] ? Number(range[1]) : 0;
      const end = range[2] ? Number(range[2]) : st.size - 1;
      if (Number.isNaN(start) || Number.isNaN(end) || start > end || end >= st.size) {
        res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
        return res.end();
      }
      res.writeHead(206, { ...base, 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${st.size}` });
      return createReadStream(abs, { start, end }).pipe(res);
    }
    res.writeHead(200, { ...base, 'Content-Length': st.size });
    return createReadStream(abs).pipe(res);
  };
  return {
    name: 'local-models',
    // Block bodies, NOT arrow expressions. `middlewares.use()` returns the connect
    // app, and vite treats a function returned from configureServer as a
    // post-hook to invoke with no arguments -- which crashes inside connect on
    // `req.url`. Returning undefined is load-bearing.
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}

export default defineConfig({
  root: 'web',
  plugins: [],
  server: {
    port: 5178,
    headers: {
      // Required for SharedArrayBuffer -> multi-threaded wasm. WebGPU does not
      // need these, but the wasm fallback path does, and you want the fallback
      // to behave the same in dev and in prod.
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  preview: {
    port: 5179,
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    target: 'esnext', // top-level await in the worker
  },
  optimizeDeps: {
    // Let the bundler leave the wasm/ort assets alone; transformers.js fetches
    // them from its own dist at runtime.
    exclude: ['@huggingface/transformers'],
  },
  worker: { format: 'es' },
});
