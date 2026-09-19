#!/usr/bin/env bun
// npm strips non-JS bin entries at publish (npm 11 rejects .tsx), so this
// shim is the installable entrypoint. Bun executes the TypeScript directly.
import "../src/index.tsx";
