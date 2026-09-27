// Build-time inlined wa-sqlite WebAssembly binary (see vite.config.ts's
// waSqliteWasmInline plugin): the plugin emits the dist/wa-sqlite.wasm bytes as
// a base64 string so nothing is fetched at runtime and the single-file build
// stays a single file.
declare module 'virtual:wa-sqlite-wasm' {
  const wasmBase64: string;
  export default wasmBase64;
}