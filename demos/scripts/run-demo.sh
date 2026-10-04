#!/usr/bin/env zsh
# Launcher for the BoE demo: the `demo` profile's configured model
# (currently ollama:gemma4:31b — see ~/.openaccountant/profiles/demo/settings.json).
export PATH="$HOME/.bun/bin:$PATH"
cd /Users/jdfiscus/dev/oss/openaccoutant/wilson
exec bun run src/index.tsx --profile demo
