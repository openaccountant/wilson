# Round 4 verdict (held-out v4, fresh blind grader)

Grades: `specs/eval/2026-10-03-round4-grades.json`, committed blind in `c59493b` before the key was opened. Key: `specs/eval/2026-10-03-round4-key.json`, copied from the scratchpad after that commit. Bars 1, 4 and 5 come from `specs/eval/2026-10-03-round4-run.md`. The stop rule is in `specs/DECISIONS.md` Round 4.

## Outcome: **stop: merge flag-off**

No arm meets the bars. Merge with `subagent.enabled` off and stop tuning (DECISIONS Round 4 stop rule). Neither arm is a candidate for default-on after #152.

## Aggregate per arm

| Arm | local | good | wrong | useless | precisionStrict | wrongOrUselessRate |
|---|---|---|---|---|---|---|
| T | 9 | 8 | 0 | 1 | 0.8889 | 0.1111 |
| O | 0 (not run: frozen cut null, harness exit 8) | - | - | - | - | - |

## Bars

| Bar | T | O |
|---|---|---|
| 1 diverted (never answered locally) >= 95%, >= 15 verb-less | **GO** (54/54 = 100%, 23 verb-less, 0 answered locally) | **NO-GO** (not run) |
| 2 local precision >= 97% | **NO-GO** (8/9 = 88.9%) | **NO-GO** (no rows) |
| 3 wrong-or-useless <= 3% | **NO-GO** (1/9 = 11.1%) | **NO-GO** (no rows) |
| 4 coverage (informational, target >= 35%) | 6.5% (9/139), target missed, not a gate | n/a; O extra "+5 pp over T" **not met** |
| 5 p95 handoff <= 2 s | **GO** (0.5 ms) | **NO-GO** (not run) |
| O extras (+5 pp over T; zero none/mutation answered locally) | n/a | **NO-GO** (arm disabled) |

## The failing row and how sensitive the outcome is to it

The only non-good answer is `86cd1618c9`, "is my car worth more than the loan" (persona 5). It was graded **useless**. The template returned the generic net-worth summary, with no yes or no and no equity figure. Vehicle $11,050.00 and Auto Loan $8,713.20 appear as separate lines, so the reader has to do the comparison. This applies the round-3 standard for a yes/no question answered by a generic template (`6ec5aee3bd`, "will i have enough for next quarters tax", graded useless). It is the row the run notes flagged in advance ("a comparison the template may not express").

**This one grade decides the outcome.** A grader who accepts the two listed lines as answering the comparison would score T 9/9: precision 100% and wrong-or-useless 0%, so all gated bars would pass and T would be a default-on candidate after #152. Under the strict rubric used in rounds 2 and 3, the defect fails. Also, at n = 9 the 97% bar tolerates zero errors. Even 9/9 would be weak evidence, and coverage would still be 6.5% against the 35% target.

All other 8 answers are good: right tool, figures match the tool and the notes, period and labels stated. Known tool quirks (the $600 card-payment leg in YTD spending, savings transfers counted as June outflow) are not answer errors.
