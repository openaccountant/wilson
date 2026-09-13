#!/usr/bin/env zsh
# Launcher for the BoE demo: granite4.1:3b on the preloaded `demo` profile.
export PATH="$HOME/.bun/bin:$PATH"
cd /Users/jdfiscus/dev/oss/openaccoutant/wilson
exec bun run src/index.tsx --profile demo
