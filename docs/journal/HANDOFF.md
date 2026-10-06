# Handoff prompt — paste this to start the new session

Continuing work in the wilson CLI worktree at
`cli/.claude/worktrees/fix+profile-switch-dashboard` (branch
`worktree-fix+profile-switch-dashboard`). Enter that existing worktree — don't
create a new one — then read `docs/journal/2026-08-29-new-profile-walkthrough.md`
in full before doing anything else; it has the complete bug table, design
decisions, and verification method. (There's also an auto-loaded memory
`wilson-demo-cf-personas` with the same summary if the journal isn't handy.)

**Working agreement:** I (Jd) drive every step that touches my real financial
data in the `Jd` profile. Don't read, import, or summarize real transaction
content — only structural signals back (counts, error text, pass/fail). This
does NOT apply to the demo-cf persona data under `scripts/demos/personas/` —
that's fully synthetic, read/edit it freely.

**Immediate next step:** I have a Quicken CSV export ready and am about to run
`/import <path>` myself into my real `Jd` profile (in the TUI, from the
worktree directory). Use `/import`, not `/skill import-transactions` — the
skill needs a configured LLM provider and this worktree has no `.env` (it's
gitignored, worktree creation doesn't copy it). I'll report back what happens
(success: count/format/date range, or the exact error) — wait for that, don't
guess at the outcome.

**Recommended order once import lands:** link-transactions (catch internal
transfers before double-counting) → entity-classify (personal/business split,
before broad categorization) → categorize → review what's left uncategorized →
tax-flag → account-manage/balance-update for investment balances → budget-set →
rule-manage → goal-manage → alert-check.

**Already done on this branch (committed):**
- Fixed `/profile switch` EADDRINUSE crash, dashboard add-profile UI gap, and
  an unvalidated-name path-traversal opening in `/api/profiles/switch`.
- Built 5 demo-cf personas (`scripts/demos/personas/`) — synthetic seed data
  spanning Chase/Amex/BofA/OFX/QIF/generic formats, each targeting a 75/10/15
  spend/save/invest goal, each verified against the real `detectFormat`/
  `detectBank` pipeline. README in that directory has full design + the
  entities-vs-accounts-vs-goals architecture answer.
- Filed [openaccountant/wilson#34](https://github.com/openaccountant/wilson/issues/34)
  for the goal_manage percentage-of-income gap found along the way.

**Still pending:** live verification of the dashboard add-profile UI fix (the
`/profile switch` fix was already confirmed live; the dashboard UI one wasn't
yet as of handoff). My real import, then continuing the link → split →
categorize → budget → tutorial-documentation loop.
