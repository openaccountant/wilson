# Contributing to Open Accountant CLI

Thank you for your interest in contributing! This document will help you get started.

## Development Setup

```bash
# Clone the repository
git clone https://github.com/open-accountant/cli.git
cd cli

# Install dependencies
bun install

# Run tests
bun test

# Type check
bun run typecheck

# Start development
bun run dev
```

## Project Structure

```
src/
├── agent/         # Agent loop and orchestration
├── tools/         # Tool registry and implementations
│   ├── import/    # Bank parsers (Chase, Amex, etc.)
│   └── ...
├── skills/        # Built-in skill definitions
├── providers.ts   # LLM provider routing
└── index.ts       # CLI entry point
```

## How to Contribute

### Reporting Bugs

Before creating a bug report:

1. Check if the bug has already been reported in [Issues](../../issues)
2. Try to reproduce with the latest version
3. Collect relevant logs (run with `--verbose` flag)

When filing a bug report, include:
- CLI version (`wilson --version`)
- Operating system
- Node.js/Bun version
- Steps to reproduce
- Expected vs actual behavior
- Relevant error messages

### Suggesting Features

Feature requests are welcome! Please:

1. Check existing [Issues](../../issues) first
2. Clearly describe the use case
3. Explain why it would be valuable
4. Consider implementation approach

### Pull Requests

1. **Fork** the repository
2. **Create a branch** (`git checkout -b feature/amazing-feature`)
3. **Make your changes**
4. **Run tests** (`bun test`)
5. **Run typecheck** (`bun run typecheck`)
6. **Commit** with a clear message
7. **Push** to your fork
8. **Open a Pull Request**

#### PR Guidelines

- Keep changes focused and atomic
- Add tests for new functionality
- Update documentation as needed
- Follow existing code style
- Use conventional commit messages

### Commit Message Convention

We follow conventional commits:

```
feat: add new bank parser for Wells Fargo
fix: resolve CSV parsing edge case
docs: update installation instructions
refactor: simplify transaction matching
test: add tests for OFX parser
```

## Development Guidelines

### Code Style

- Use TypeScript strict mode
- Prefer explicit types over `any`
- Use descriptive variable names
- Keep functions small and focused

### Testing

- Write tests for new parsers and tools
- Test edge cases (empty files, malformed data)
- Use descriptive test names
- Mock external APIs

#### GPU-gated tests

`src/__tests__/webgpu-model-path.test.ts` covers the WebGPU model path in four
layers. The first two need no GPU and run in CI on both Linux and macOS: they
check that the `webgpu` device resolves to the WebGPU execution provider, that
every `webgpu`-tagged model matches the dispatch patterns, and that the
capability probe returns a boolean without throwing.

Layers 3 and 4 download roughly 600 MB and need a working GPU, so they are
skipped unless you opt in:

```bash
WILSON_GPU_TESTS=1 bun test src/__tests__/webgpu-model-path.test.ts
```

Layer 3 loads `onnx-community/Qwen3-0.6B-ONNX` on the WebGPU device and
generates 16 tokens. Layer 4 runs 30 generations and asserts that the mean RSS
delta over the last 10 stays under 1 MB, which guards against a regression of
the FFI leak in oven-sh/bun#19322.

### Documentation

- Update README.md for user-facing changes
- Add JSDoc comments for public APIs
- Update skill documentation in `docs/skills/`

## Release Process

Releases are automated via GitHub Actions:

1. Maintainer creates a release on GitHub
2. CI runs tests and typecheck
3. Package is published to npm
4. Monorepo is notified to update documentation

## Merge Pipeline (Dependabot & the SPF factory)

`main` is protected by a repository ruleset: 1 approving review, the three
`check` status checks, and a required merge queue. That's normal for an OSS
repo with outside contributors — but this repo also runs two automated PR
sources (Dependabot, and an internal agent pipeline called SPF that opens
`spf-watch/*` branches from issues), and neither of those can ever satisfy
"1 approving review" the naive way: the repo has a single human maintainer,
and GitHub refuses to let a PR's own author approve it. Left as-is, every
automated PR just sits open forever, drifting further from `main` each day
until it collides with whatever else has since merged.

Two workflows close that gap for sources this repo already trusts —
**Dependabot** and the maintainer's own **`spf-watch/*`** branches. Anything
else, including any outside contributor's PR, is untouched by either and
still needs a human to review and merge it.

### `.github/workflows/dependabot-lockfile-fix.yml`

Dependabot's npm ecosystem support bumps `package.json` but doesn't
regenerate `bun.lock` (this repo uses Bun, not npm/yarn), so `bun install
--frozen-lockfile` fails CI on essentially every dependency PR. This
workflow runs on `pull_request_target` (the one trigger that still gets a
real token when Dependabot is the actor — `pull_request` from Dependabot is
forced read-only with no secrets, regardless of declared permissions),
regenerates `bun.lock`, and pushes the fix straight to the PR branch, which
re-triggers CI with a working lockfile.

### `.github/workflows/auto-approve-trusted.yml`

Runs after CI finishes on a PR. If CI passed, it mints a token for the
`release-bot` GitHub App (already on the ruleset's bypass list for release
commits) and has that identity — distinct from the PR author — submit the
approving review, then enables `gh pr merge --auto` so the PR joins the
merge queue the moment it's mergeable, for:

- any PR from the maintainer on a `spf-watch/*` branch, or
- a `dependabot[bot]` PR that's grouped (title contains `group`, e.g. the
  `minor-and-patch` group) or a standalone same-major-version bump (title
  matches `bump X from A to B` with the same leading version number) — i.e.
  exactly what [`docs/dependency-policy.md`](docs/dependency-policy.md)
  already calls safe to fast-track.

A standalone **major**-version Dependabot bump is deliberately left alone —
it still needs the manual validation steps in that doc and a human running
`gh pr merge --admin` once satisfied. If the title doesn't match either
recognized pattern, this workflow fails closed (treats it as untrusted)
rather than guessing.

If this stops approving PRs, the most likely cause is the `release-bot` App
missing the `pull-requests: write` permission — grant it in the App's
settings under the org's GitHub App configuration.

### SPF concurrency

`.spf/spf.config.yaml`'s `watch.concurrency` controls how many issues SPF
works simultaneously; each one cuts a branch from `main` at the moment work
starts. Higher concurrency was directly responsible for a pile of
conflicting PRs in 2026-09 — several issues in flight at once, each drifting
from `main` as the others (and everything else) merged first, produced real
content conflicts by the time anything got reviewed. It's set to `1` for
now; raise it again once auto-approve + the merge queue are reliably
clearing PRs same-day, since concurrency is only risky when PRs sit
unmerged.

### If you need to merge something these don't cover

For anything outside this — an unusual dependency bump, a manual fix, a PR
that needs a human's judgment before merging — merge it deliberately as the
repo owner: `gh pr merge <n> --admin --squash`. `--admin` uses the owner's
standing bypass on the ruleset; it's the same mechanism a second human
reviewer would otherwise provide, just without needing one on a
solo-maintainer repo. Don't reach for it as a way to skip a CI failure you
haven't understood — see [`docs/dependency-policy.md`](docs/dependency-policy.md)
for when a red check needs investigation instead of a bypass.

## Automated Watches

### `@huggingface/kernels` upstreaming watch

`.github/workflows/kernels-watch.yml` runs monthly (`workflow_dispatch` also
available) to check whether Hugging Face's `@huggingface/kernels` WebGPU
kernels are being upstreamed into ONNX Runtime Web / transformers.js. See
[issue #41](../../issues/41) and `docs/research/webgpu-kernels/` in the
monorepo for background — if this lands, wilson inherits the speedups
through the existing `@huggingface/transformers` dependency with no
integration work.

Each run checks, via `gh api` (bash + `jq` only):

- `microsoft/onnxruntime` issues/PRs (updated in the last 35 days) mentioning
  `huggingface/kernels`, `webgpu-kernels`, or `@huggingface/kernels`, plus PRs
  by `nico-martin` / `xenova` that touch `js/web` or
  `onnxruntime/core/providers/webgpu`.
- `huggingface/transformers.js` releases (last 35 days) whose body mentions
  "kernels".
- The npm registry for `@huggingface/kernels`, comparing published versions
  against the baseline recorded in `.github/kernels-watch/last-seen.json`.

If it finds a hit, it opens (or comments on an existing open) issue titled
`watch: @huggingface/kernels upstreaming activity detected` with the
`enhancement` label. If nothing is found, it exits quietly with a one-line
job summary.

**Bumping the baseline:** once you've triaged a new `@huggingface/kernels`
npm release (so it stops being reported as "new" every run), update
`.github/kernels-watch/last-seen.json`:

```json
{
  "npmVersions": ["0.0.1-preview.1", "0.0.1-preview.2"],
  "checkedAt": "2026-10-01"
}
```

Append the new version(s) to `npmVersions` (don't remove old ones — the
workflow only checks for versions *not* in the list) and set `checkedAt` to
today's date, then commit the file.

## Community

- Be respectful and constructive
- Help others in Issues and Discussions
- Follow the [Code of Conduct](./CODE_OF_CONDUCT.md)

## Questions?

- Check [Discussions](../../discussions) for Q&A
- Join our [Discord](https://discord.gg/openaccountant) (if applicable)
- Open an Issue for bugs or feature requests

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
