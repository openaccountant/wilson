#!/usr/bin/env zsh
# Launcher for feature-showcase recordings: the `showcase` profile (a clone of
# `demo`, model ollama:gemma4:31b), so imports/budgets don't touch the hero data.
export PATH="$HOME/.bun/bin:$PATH"
cd /Users/jdfiscus/dev/oss/openaccoutant/wilson
exec bun run src/index.tsx --profile showcase
