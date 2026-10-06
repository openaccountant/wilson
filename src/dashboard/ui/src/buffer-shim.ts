// csv-parse (pulled in transitively by the client-side statement parsers)
// references the bare `Buffer` global, which browsers don't have. This must be
// the first thing evaluated — import it before anything else in main.tsx, as
// a side-effect-only import, so the assignment below runs before any other
// module (which ES module evaluation order would otherwise run first).
import { Buffer } from 'buffer';

if (typeof (globalThis as { Buffer?: unknown }).Buffer === 'undefined') {
  (globalThis as { Buffer?: unknown }).Buffer = Buffer;
}
