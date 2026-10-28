# Teardown: LFM3-1.7B WebGPU workspace (Hugging Face Space)

Date: 2026-10-28
Subject: [`webml-community/LFM3-1.7B-WebGPU-Pi`](https://huggingface.co/spaces/webml-community/LFM3-1.7B-WebGPU-Pi), commit `3ad7ce8`
Method: static reading of the published `dist/` files (about 4.8 MB, no weights) plus automated static analysis of the bundle (11 JavaScript files, about 817k AST nodes). Nothing was executed and no inference ran. Nothing in this document was measured in a browser.

Why: we want a chat / files split in the dashboard (see `docs/plans/2026-10-28-004-chat-workspace-plan.md`), and this Space is the clearest public example of a browser-local agent with a workspace.

## 1. What it is

A static site. LFM3-1.7B runs on WebGPU, a Pi terminal sits on the left, and a file tree, editor and shell sit on the right. Everything runs in the browser.

```
main thread (Pi terminal UI, xterm, editor, file tree)
   | postMessage RPC {id, action, args}
   v
agent.worker.js -> WorkspaceController -> Agent (runtime/agent.js)
                                            | generate() -> stream events
                                            v
                                 Lfm3ForCausalLM.js (WebGPU, GGUF)
                 tools: read / write / edit / bash  (just-bash, virtual FS)
```

| Part | Size | License |
|---|---|---|
| `src/*.js`: worker, controller, config, conversation adapter, workspace | about 550 readable lines | Apache-2.0 |
| `vendor/just-bash.js`: virtual shell (Vercel) | 1.2 MB | Apache-2.0 |
| Pi terminal components (Earendil Works, Pi 0.85.1) | in `assets/` | MIT |
| `runtime/agent.js`: tool loop | 6 KB, minified | **"Supplied", no license stated** |
| `runtime/Lfm3ForCausalLM.js`: inference engine | 1 MB, minified | **"Supplied", no license stated** |

The README lists `docs/` (runtime API notes) and `test/` folders. Neither is published in the Space.

## 2. The inference runtime

- **GGUF on WebGPU, without ONNX Runtime.** It loads `LiquidAI/LFM3-1.7B-GGUF` (Q4_K_M by default, or QAD Q4_0) directly from the Hub, using `Range` requests.
- **Shaders.** About 55 inline WGSL compute shaders. The README says "17 kernels and 50 variants". They cover Q4_K/Q5_K/Q6_K/Q4_0 dequantization, subgroup and subgroup-matrix paths, and `shader-f16`.
- **Device checks.** `checkAvailability()` refuses the device before any download if a required feature or limit is missing.
- **Caching.** Weights go to IndexedDB. There are **no** `navigator.storage` calls (no `persist()`, no quota estimate), so eviction is possible.
- **Model-specific state.** The KV cache handles sliding-window attention with a ring buffer and keeps short-convolution state for LFM's hybrid layers.
- **One model only.** The bundle header says `model hints: lfm3`. It is not a general runtime.
- **Errors are typed:** `ContextOverflowError`, `DeviceLostError`, `BusyError`. When the GPU device is lost, the model has to be loaded again.
- **Tool-call format.** The model writes `<function name="..."><param name="...">...</param></function>`. The runtime also accepts `<tool_call>...</tool_call>`. It sends a dummy tool through the chat template (`webgpu_delimiter_probe`) to find the delimiters.

Relevance to us: our browser stack is transformers.js plus ORT-web, and a 1.7B q4f16 model fails to load there (`bad_alloc`, #154). A GGUF-native engine may avoid that. **We cannot vendor this one** until its license and source are published.

## 3. The agent loop (patterns worth reimplementing)

1. **KV reuse across turns.** The full prompt is re-tokenized each turn, the longest prefix matching the cache is kept, and only the new tail is prefilled. `config.js` keeps instructions and tool definitions stable to protect that prefix.
2. **Failed-call memory.** If the model repeats a tool call that just failed (same name and same JSON arguments), the call is not run again. The model gets: "This exact call already failed: ... Change the call, or tell the user what went wrong." The memory clears on the next successful call.
3. **Failure is an exception.** A shell command that exits non-zero throws, which feeds item 2.
4. **Honest history.** A stopped partial reply stays visible but is left out of the model's history. A full context raises an error and history is never silently cut.
5. **Bounded rounds.** Settings are `max_rounds: 12`, `max_new_tokens: 4096`, a 32,768-token context, and `do_sample: false`.

## 4. Files

- **One in-memory virtual filesystem** (just-bash), rooted at `/workspace` and owned by the worker. The model's tools, the editor and the shell all use it.
- **Shell limits** (`hardened` profile): 10 s per command, 3,000 commands, 16 MB filesystem, 256 KB output, 128 KB source. `cd` and shell variables reset on every call. There is no network, Node or Python, so the model computes with `jq` and `awk`.
- **Tools:**
  - `read` resolves the real path first.
  - `write` creates parent directories.
  - `edit` replaces text that must match **exactly once**, otherwise it fails with "Read the file first."
  - `bash` returns stdout, stderr and the exit code.
  - Output to the model is cut at 6,000 characters, with a hint to use `head` or `grep`.
- **Persistence.** After every tool result or edit, the whole state goes into one IndexedDB key (`state/current`): files as base64 with their modes, directories, symlinks, model history, display history and the chosen quantization. All file contents are then posted to the UI.
- **Import** takes text files only, up to 1 MiB, and never overwrites an existing name. **Export** writes a JSON snapshot that includes chat history.
- **Layout.** Chat, then a keyboard-accessible column resizer, then file tree, editor and shell.

## 5. Gaps

| # | Gap |
|---|---|
| G1 | The model edits files with no diff, review, undo or history |
| G2 | Multiple tabs overwrite each other: one key, no `BroadcastChannel` or Web Locks |
| G3 | The 1.1 GB weight cache can be evicted (no `persist()`) |
| G4 | Every save rewrites and re-posts every file |
| G5 | Large files are hard for the model (6,000-character output cap, 1 MiB editor cap) |
| G6 | No delete UI found. Import is text-only and won't overwrite. Export includes chat |
| G7 | File contents can carry prompt injection (harmless with no network, not harmless next to mutating tools) |
| G8 | Not verified on real devices (the Space says so itself). Support on browsers without subgroups is unknown |

## 6. Cross-Origin Storage (WICG)

[WICG/cross-origin-storage](https://github.com/WICG/cross-origin-storage) is a cache keyed by SHA-256 hash and shared across sites, through `navigator.crossOriginStorage`. It is an explainer only: there is a Chrome extension polyfill and a Vite plugin, and no browser ships it. The listed supporters are web developers only.

- **Helps:** G3 in part (the browser manages the cache, though least-recently-used eviction is still allowed). It also avoids downloading the same weights again for each site (Space, dashboard, demo sandbox), and the hash check covers weight integrity.
- **Doesn't help:** G1, G2 or G4. **Must never hold user data.** Sharing with every site is only for public files such as base weights. Per-user fine-tuned heads stay same-site.

## 7. Takeaways for Open Accountant

- Reimplement patterns 1–4 from section 3 in the hybrid subagent. This carries no license risk.
- Build a chat / files split with just-bash, which is Apache-2.0. Adapt the file model to our books: read-only data views, a writable workspace, and changes only through approval cards.
- Treat the GGUF runtime as an experiment we can't ship: benchmark it in a scratch directory and ask upstream about the license.
- Add `navigator.storage.persist()` now. Put a COS check behind a flag later.
