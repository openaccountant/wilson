# specs/eval

Evaluation data and reports for the browser subagent (`specs/browser-subagent.md`).

- `heldout-router.v1-burned.jsonl` - **BURNED.** The first held-out routing set. It was read while writing the slice-8 report and the keyword router, gate and answer rules changed afterwards (Round 2, precision-first), so it can no longer measure anything. Kept as an archive and as scorer-shape test data only. Never use it for a go/no-go and never tune against it.
- `heldout-router.v2.jsonl` - written independently by a fresh author for Round 2. Rule authors must not open it. If any rule is tuned against its results it is burned too and a v3 is needed.
- `2026-10-02-slice8-*` - the slice-8 run (NO-GO) that triggered Round 2.
- `2026-10-03-round2-*` - the Round-2 run on v2 (NO-GO): `.md` report, `.json` per-row results and graded verdicts, `-grades.json` the per-answer grades with reasons. v2 was not tuned against and is not burned by this run.
- `heldout-router.v3.jsonl` - written by a fresh author for Round 3 (196 rows, with a `mutation` field and `persona`). Rule authors must not open it; tuning against it burns it. Not burned by the Round-3 run.
- `fixtures-v3.md` - the augmented synthetic persona books v3 was written from.
- `2026-10-03-round3-*` - the Round-3 run on v3: `-run.md` report (bars 1, 4, 5 for arms T and M6; arm M17 did not load), `-results.json` per row per arm, `-blind.jsonl` the arm-blinded grading file, `-key.json` the id -> arm key (do not open before grading).
- **Round 4** (DECISIONS "Round 4"): v1, v2 and v3 are **burned** and are dev sets (round-4 fixes came from v3's failures). `heldout-router.v4.jsonl` is the held-out set for Round 4, written by a fresh author; rule authors must not open it.
- `2026-10-03-round4-dev-cut.{md,json}` - the pre-registered open-jev margin-cut selection (`specs/browser-subagent-round4-openjev-router.md` §5) on the dev union only (v1-burned, v2, v3, spike route set), real WebGPU, both option renderings (descriptions, then the bare-label fallback once). Result: **no viable cut**, so arm O is disabled.
- `round4-openjev-frozen.json` - the frozen arm-O configuration (cut, question, options, model pins, dev-file hashes), committed before any held-out arm-O run. `src/__tests__/openjev-route-frozen.test.ts` keeps the product constants equal to it, and the harness refuses `--arm O` on `heldout-router.v4*` without `--frozen-sha` matching it (and refuses outright while its cut is null).
