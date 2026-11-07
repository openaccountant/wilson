# Decisions for specs/model-manager.md (2026-11-07)

"Jd" = Jd decided it in the 2026-11-07 conversation. "default" = an orchestrator default Jd may override.

| # | Question | Decision | By |
|---|---|---|---|
| M-D1 | How much model freedom? | The vetted catalog plus **any public Hub repo**, after server-side validation and a browser benchmark. | Jd |
| M-D2 | Base branch | `main` (the 0.10.1 train). `release/0.10.0` has shipped. | Jd |
| M-D3 | Cross-Origin Storage | Built now, behind the flag `modelCache.crossOriginStorage`, default off. Used only for model weights, never user data. | Jd ("COS seems dope", chat-workspace D12) |
| M-D4 | COS write scope | `origins: '*'`, because Hub weights are public. Same-site sharing across localhost ports works without the PHL. | default |
| M-D5 | COS method name | `getFileHandle` first, then `requestFileHandle`. Transformers.js 4.3.2 only calls the old name, so we use our own `customCache` adapter instead of `env.experimental_useCrossOriginStorage`. | default |
| M-D6 | Revision policy | Never load `main` live. Catalog entries pin a sha. A custom repo resolves its sha when added. Updates are explicit and reset that model's capability verdict and bench results. | default |
| M-D7 | Gated or private repos | Refused in v1. A Hub token would have to live in the browser. | default |
| M-D8 | Bench storage | Browser `localStorage` only. No migration (v34–v40 are reserved). | default |
| M-D9 | EmbeddingGemma 2 | Not added. It waits on the open browser-vs-Ollama embedding decision (September D5). | default |
| M-D10 | Kernels | Fast follow, in its own spec, once M1–M6 land. | Jd |
