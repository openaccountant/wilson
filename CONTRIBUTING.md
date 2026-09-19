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
