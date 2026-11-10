#!/usr/bin/env bash
# Set up a fresh Mac as the show machine for the live WebMCP segment, then run the preflight.
#   demos/live/setup-show-machine.sh [--status] [--dir PATH] [--ref BRANCH] [--macos] [--with-models] [--with-cli] [--no-check]
#
#   --status       report what is installed and what is missing; change nothing
#   --dir PATH     where to clone wilson (default ~/dev/wilson; an existing checkout is reused)
#   --ref BRANCH   branch to check out (default feat/webmcp-live-test, the kit's branch until #188 merges)
#   --macos        stage settings: no sleep, no automatic macOS updates (needs sudo; prints how to undo)
#   --with-models  Ollama + gemma4:12b + granite4.1:3b (only for recording or local chat; the live segment needs none)
#   --with-cli     also `npm i -g @openaccountant/wilson@0.10.0` (the kit itself runs from the clone)
#   --no-check     skip the closing `webmcp-live.mjs check --fresh`
#
# Safe to re-run: every step checks first and skips what is already there. The live segment itself needs no LLM and no
# network beyond localhost; this script needs the network.
set -euo pipefail

REPO_URL="https://github.com/openaccountant/wilson.git"
DIR="$HOME/dev/wilson"
REF="feat/webmcp-live-test"
BUN_VERSION="1.4.2"     # matches .bun-version and CI
NODE_FORMULA="node@22"  # matches release-on-merge.yml
CHROME_APP="/Applications/Google Chrome.app"
CHROME_MIN=156
MODELS=(gemma4:12b granite4.1:3b)
STATUS=0; MACOS=0; WITH_MODELS=0; WITH_CLI=0; CHECK=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --status) STATUS=1; shift;;
    --dir) DIR="${2:?--dir needs a path}"; shift 2;;
    --ref) REF="${2:?--ref needs a branch}"; shift 2;;
    --macos) MACOS=1; shift;;
    --with-models) WITH_MODELS=1; shift;;
    --with-cli) WITH_CLI=1; shift;;
    --no-check) CHECK=0; shift;;
    -h|--help) sed -n '2,13p' "$0"; exit 0;;
    *) echo "unknown option $1" >&2; exit 2;;
  esac
done

bold=$'\e[1m'; dim=$'\e[2m'; green=$'\e[32m'; yellow=$'\e[33m'; red=$'\e[31m'; off=$'\e[0m'
step() { printf '\n%s==> %s%s\n' "$bold" "$*" "$off"; }
ok()   { printf '  %s✓%s %s\n' "$green" "$off" "$*"; }
todo() { printf '  %s•%s %s\n' "$yellow" "$off" "$*"; MISSING=$((MISSING + 1)); }
die()  { printf '%s✗ %s%s\n' "$red" "$*" "$off" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }
MISSING=0

[[ "$(uname -s)" == Darwin ]] || die "macOS only"

# Homebrew lives in /opt/homebrew on Apple silicon; a fresh shell may not have it on PATH yet.
[[ -x /opt/homebrew/bin/brew ]] && eval "$(/opt/homebrew/bin/brew shellenv)"
[[ -d "$HOME/.bun/bin" ]] && export PATH="$HOME/.bun/bin:$PATH"
NODE_PREFIX="$(have brew && brew --prefix "$NODE_FORMULA" 2>/dev/null || true)"
[[ -n "$NODE_PREFIX" && -d "$NODE_PREFIX/bin" ]] && export PATH="$NODE_PREFIX/bin:$PATH"

chrome_major() {
  [[ -x "$CHROME_APP/Contents/MacOS/Google Chrome" ]] || { echo 0; return; }
  "$CHROME_APP/Contents/MacOS/Google Chrome" --version 2>/dev/null | sed -E 's/^Google Chrome ([0-9]+).*/\1/'
}

# ── --status: report only ─────────────────────────────────────────────────────
if [[ $STATUS == 1 ]]; then
  step "Show machine status"
  xcode-select -p >/dev/null 2>&1 && ok "Xcode Command Line Tools" || todo "Xcode Command Line Tools"
  for t in brew git gh node bun; do have "$t" && ok "$t $("$t" --version 2>/dev/null | head -1)" || todo "$t"; done
  have bun && [[ "$(bun --version)" != "$BUN_VERSION" ]] && todo "bun is $(bun --version), the repo pins $BUN_VERSION"
  CM="$(chrome_major)"; (( CM >= CHROME_MIN )) && ok "Chrome $CM" || todo "Chrome $CHROME_MIN+ (found: ${CM/#0/none})"
  [[ -e "$DIR/.git" ]] && ok "clone at $DIR ($(git -C "$DIR" rev-parse --abbrev-ref HEAD))" || todo "clone at $DIR"
  [[ -d "$DIR/node_modules" ]] && ok "bun install" || todo "bun install"
  [[ -f "$DIR/src/dashboard/ui/dist/index.html" ]] && ok "dashboard UI built" || todo "dashboard UI build (#195: npm ships none)"
  [[ -d "$DIR/demos/live/node_modules/agent-browser" ]] && ok "demos/live deps (agent-browser)" || todo "demos/live npm install"
  if have ollama; then
    for m in "${MODELS[@]}"; do grep -q "^$m" <<<"$(ollama list 2>/dev/null)" && ok "ollama $m" || printf '  %s-%s ollama %s (optional)\n' "$dim" "$off" "$m"; done
  fi
  pmset -g | grep -qE '^ +sleep +0' && ok "system sleep off" || printf '  %s-%s system sleep is on (--macos turns it off)\n' "$dim" "$off"
  echo; [[ $MISSING == 0 ]] && ok "ready: run  node demos/live/webmcp-live.mjs check --fresh" || echo "$MISSING item(s) missing: re-run without --status"
  exit 0
fi

# ── toolchain ─────────────────────────────────────────────────────────────────
step "Xcode Command Line Tools"
if xcode-select -p >/dev/null 2>&1; then ok "installed"
else
  xcode-select --install || true
  die "finish the Command Line Tools installer dialog, then re-run this script"
fi

step "Homebrew"
if have brew; then ok "$(brew --version | head -1)"
else
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  eval "$(/opt/homebrew/bin/brew shellenv)"
  grep -q 'brew shellenv' "$HOME/.zprofile" 2>/dev/null || echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> "$HOME/.zprofile"
  ok "installed"
fi

step "git, gh, $NODE_FORMULA"
for f in git gh "$NODE_FORMULA"; do brew list --formula "$f" >/dev/null 2>&1 && ok "$f" || brew install "$f"; done
NODE_PREFIX="$(brew --prefix "$NODE_FORMULA")"; export PATH="$NODE_PREFIX/bin:$PATH"
grep -q "$NODE_FORMULA/bin" "$HOME/.zprofile" 2>/dev/null || echo "export PATH=\"$NODE_PREFIX/bin:\$PATH\"" >> "$HOME/.zprofile"
ok "node $(node --version)"

step "bun $BUN_VERSION"
if have bun && [[ "$(bun --version)" == "$BUN_VERSION" ]]; then ok "bun $(bun --version)"
else
  curl -fsSL https://bun.sh/install | bash -s "bun-v$BUN_VERSION"
  export PATH="$HOME/.bun/bin:$PATH"
  ok "bun $(bun --version)"
fi

step "Google Chrome $CHROME_MIN+"
CM="$(chrome_major)"
if (( CM == 0 )); then brew install --cask google-chrome; CM="$(chrome_major)"; fi
(( CM >= CHROME_MIN )) && ok "Chrome $CM" \
  || die "Chrome $CM is older than $CHROME_MIN: open Chrome → About Google Chrome to update it, then re-run"

# ── wilson + the live kit ─────────────────────────────────────────────────────
step "wilson ($REF) at $DIR"
if [[ -e "$DIR/.git" ]]; then
  [[ -z "$(git -C "$DIR" status --porcelain --untracked-files=no)" ]] || die "$DIR has uncommitted changes; leaving it alone"
  git -C "$DIR" fetch -q origin
else
  mkdir -p "$(dirname "$DIR")"
  git clone -q "$REPO_URL" "$DIR"
fi
git -C "$DIR" checkout -q "$REF" 2>/dev/null || git -C "$DIR" checkout -q -b "$REF" "origin/$REF"
git -C "$DIR" merge -q --ff-only "origin/$REF"
ok "$(git -C "$DIR" log --oneline -1)"

step "Dependencies and dashboard UI"
(cd "$DIR" && bun install --frozen-lockfile >/dev/null) && ok "bun install"
# npm installs ship no React UI (#195), so the kit always serves the one built here.
(cd "$DIR/src/dashboard/ui" && npm ci --silent && npm run build >"$DIR/.ui-build.log" 2>&1) && ok "UI built" \
  || die "UI build failed; see $DIR/.ui-build.log"
(cd "$DIR/demos/live" && npm install --silent) && ok "demos/live (agent-browser $(cd "$DIR/demos/live" && node -p "require('agent-browser/package.json').version"))"

if [[ $WITH_CLI == 1 ]]; then
  step "wilson CLI 0.10.0 (global)"
  npm i -g --silent @openaccountant/wilson@0.10.0 && ok "installed"
fi

# ── optional: local models (recording / local chat only) ──────────────────────
if [[ $WITH_MODELS == 1 ]]; then
  step "Ollama + ${MODELS[*]}"
  [[ -d /Applications/Ollama.app ]] || brew install --cask ollama
  have ollama || export PATH="/Applications/Ollama.app/Contents/Resources:$PATH"
  curl -sf 127.0.0.1:11434/api/tags >/dev/null || { open -a Ollama; for _ in $(seq 30); do curl -sf 127.0.0.1:11434/api/tags >/dev/null && break; sleep 1; done; }
  # The first gemma download took ~25 min on the laptop: do it days ahead, never at the venue.
  for m in "${MODELS[@]}"; do grep -q "^$m" <<<"$(ollama list)" && ok "$m" || ollama pull "$m"; done
fi

# ── optional: macOS stage settings ────────────────────────────────────────────
if [[ $MACOS == 1 ]]; then
  step "macOS stage settings (sudo)"
  sudo pmset -a sleep 0 displaysleep 0 disksleep 0 && ok "no system, display or disk sleep"
  sudo defaults write /Library/Preferences/com.apple.SoftwareUpdate AutomaticDownload -bool false
  sudo defaults write /Library/Preferences/com.apple.SoftwareUpdate AutomaticallyInstallMacOSUpdates -bool false
  ok "automatic macOS update download and install off"
  printf '  %sundo after the talk:%s sudo pmset -a sleep 1 displaysleep 10 disksleep 10; sudo defaults delete /Library/Preferences/com.apple.SoftwareUpdate AutomaticDownload; sudo defaults delete /Library/Preferences/com.apple.SoftwareUpdate AutomaticallyInstallMacOSUpdates\n' "$dim" "$off"
fi

# ── preflight ─────────────────────────────────────────────────────────────────
if [[ $CHECK == 1 ]]; then
  step "Preflight: webmcp-live.mjs check --fresh"
  (cd "$DIR" && node demos/live/webmcp-live.mjs check --fresh) && ok "check passed"
fi

step "By hand (not scriptable)"
cat <<EOF
  • Focus → Do Not Disturb on, for the whole talk
  • Displays: set the resolution on the real stage monitor; hide the Dock if it covers the terminal
  • Copy the fallback clips to the Desktop and the USB stick:
      live-fallback-0100.mp4, b9-kill-0100.mp4 (plus b5 and b10 for slides 11/16/18)
  • Rehearse: terminal 1  node demos/live/webmcp-live.mjs up
              terminal 2  node demos/live/webmcp-live.mjs stage, then reset, then stage again
EOF
