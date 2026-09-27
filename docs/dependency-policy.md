# Dependency update policy

Defines which Dependabot bumps are safe to fast-track and which need
validation before merge. `.github/dependabot.yml` already encodes half of
this (grouping patch/minor updates); this doc covers the rest of the
decision and what "validated" means for the bumps that don't get grouped.

## Safe — fast-track once CI is green

- **Patch and minor npm bumps.** Grouped by dependabot.yml's
  `minor-and-patch` group (single PR, e.g. #32). Semver contract says these
  don't change public API; merge once `bun run typecheck` and `bun test`
  pass unmodified.
- **Patch and minor GitHub Actions bumps.** Grouped by dependabot.yml's
  `actions` group. Merge once the workflow run on the PR itself succeeds.

No human validation step is required for these beyond green CI — that's
the point of grouping them. As of 2026-09-25 this is also enforced by
automation, not just policy: `.github/workflows/dependabot-lockfile-fix.yml`
regenerates `bun.lock` when Dependabot bumps `package.json` without it (the
most common reason these PRs went red), and
`.github/workflows/auto-approve-trusted.yml` approves and enables auto-merge
once CI is green — see [`CONTRIBUTING.md`](../CONTRIBUTING.md#merge-pipeline-dependabot--the-spf-factory)
for how both work. Major bumps below still need the manual validation
steps and a deliberate `gh pr merge --admin` — neither workflow touches
those.

## Needs validation — major version bumps

Dependabot always opens major bumps as their own PR (they're excluded from
the minor/patch groups), one per dependency. Before merging one:

1. **Read the release notes** for the specific major version jump and note
   anything relevant to how this repo uses the package or action.
2. **npm packages:** install the bumped version, then run the full quality
   chain (`bun run typecheck`, `bun test` — same `all` suite SPF gates on).
   Fix any failure caused specifically by the bump. Do not fix unrelated
   pre-existing failures in the same PR — call them out separately instead.
3. **GitHub Actions:** grep every workflow under `.github/workflows/` that
   references the action. Check for renamed/removed inputs or outputs, new
   required runner versions (e.g. Node version bumps), and changed default
   permissions. Confirm the workflow still runs green on the PR.
4. **Record the outcome** in the PR description: what was checked, what
   (if anything) broke, what was changed to fix it, and why the bump is now
   safe to merge.
5. **Never bundle an unrelated change** into a dependency-bump PR — if
   fixing the bump surfaces or requires an unrelated behavior change, split
   it into its own PR and link it instead of merging it silently alongside
   the version bump.

## Never auto-merge

- Anything touching `.env`, `.env.*`, or a path listed under
  `protected_files` in `.spf/spf.config.yaml` — needs a human regardless of
  semver.
- Anything where CI is red and the cause isn't understood yet.

## Major-bump backlog

Clear as of 2026-09-25 — the 2026-09-19 backlog (#4, #5, #7, #9, #10, #12,
#13) and everything grouped/minor since (#32, #118–#122) all merged. Track
new major bumps here as Dependabot opens them; this table should stay short
if the fast-track path above is doing its job.

| PR | Bump | Status |
|----|------|--------|
