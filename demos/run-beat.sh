#!/usr/bin/env bash
# One command to record and cut a beat: real dashboard, real LLM agent (Claude Code headless), real footage.
#   demos/run-beat.sh <beat> [--take N] [--with-injection] [--short-history] [--no-render] [--actor-timeout S]
# Output: /private/tmp/claude-501/wilson-demos/<beat>/take<N>/{video.mp4,events.json,ab-audit.jsonl,actor.log,actor.jsonl,frames/,cut.mp4}
set -uo pipefail

BEAT="${1:-}"; [[ -z "$BEAT" || "$BEAT" == --* ]] && { sed -n '2,4p' "$0"; exit 2; }
shift
TAKE=""; RESET_FLAGS=(); RENDER=1; ACTOR_TIMEOUT_S=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --take) TAKE="${2:-}"; shift 2;;
    --with-injection|--short-history) RESET_FLAGS+=("$1"); shift;;
    --no-render) RENDER=0; shift;;
    --actor-timeout) ACTOR_TIMEOUT_S="${2:-}"; shift 2;;
    *) echo "unknown option $1" >&2; exit 2;;
  esac
done
[[ "$BEAT" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || { echo "bad beat name" >&2; exit 2; }

DEMOS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$DEMOS/.." && pwd)"
RIG="$DEMOS/rig"
MEDIA=/private/tmp/claude-501/wilson-demos
NAME="run-$BEAT"                       # rig workspace (home, chrome profile, pid files)
DASH_PORT=3141; CDP_PORT=9333; CTL_PORT=9400
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
MODEL="ollama:gemma4:12b"
cd "$REPO"

say() { printf '[run-beat] %s\n' "$*"; }
FAIL_REASON=""
die() { FAIL_REASON="$*"; printf '[run-beat] FAILED: %s\n' "$*" >&2; exit 1; }

# ---------- preflight ----------
for t in node bun ffmpeg ffprobe curl lsof; do command -v "$t" >/dev/null || die "$t not found on PATH"; done
command -v claude >/dev/null || die "claude CLI not found on PATH (needs a logged-in Claude Code)"
[[ -x "$CHROME" ]] || die "system Chrome not found at $CHROME"
CV="$("$CHROME" --version 2>/dev/null)"; [[ "$CV" == *"Chrome 154."* ]] || die "need Chrome 154.x, found: $CV"
curl -sf --max-time 5 http://127.0.0.1:11434/api/tags | grep -q '"gemma4:12b"' || die "ollama is not serving gemma4:12b on 127.0.0.1:11434 (ollama serve; ollama pull gemma4:12b)"
[[ -f "$RIG/beats/$BEAT.mjs" ]] || die "no beat $RIG/beats/$BEAT.mjs"
[[ -f "$RIG/beats/$BEAT.brief.md" ]] || die "no agent brief $RIG/beats/$BEAT.brief.md"
for p in $DASH_PORT $CDP_PORT $CTL_PORT; do
  lsof -nP -iTCP:$p -sTCP:LISTEN -t >/dev/null 2>&1 && die "port $p is in use (leftover host? node demos/rig/stop.mjs --name $NAME)"
done
node -e "import('$RIG/lib/agent-browser.mjs').then(m=>{const r=m.resolveAgentBrowser();console.log('[run-beat] agent-browser '+r.version+' '+r.bin)}).catch(e=>{console.error(e.message);process.exit(1)})" \
  || die "vendored agent-browser check failed"
[[ $RENDER -eq 0 || -f "$DEMOS/compose/beats/$BEAT.json" ]] || die "no compose config $DEMOS/compose/beats/$BEAT.json (use --no-render)"

# ---------- take dir ----------
BEAT_ROOT="$MEDIA/$BEAT"; mkdir -p "$BEAT_ROOT"
if [[ -z "$TAKE" ]]; then
  TAKE=1; while [[ -e "$BEAT_ROOT/take$TAKE" ]]; do TAKE=$((TAKE+1)); done
fi
[[ "$TAKE" =~ ^[0-9]+$ ]] || die "--take must be a number"
TAKE_DIR="$BEAT_ROOT/take$TAKE"
if [[ -e "$TAKE_DIR" ]]; then
  # A take that FAILED (marker written by this script) is evidence, not a result: it is moved aside, never deleted,
  # so the same --take number can be retried. Anything else is never touched.
  if [[ -f "$TAKE_DIR/FAILED" ]]; then
    ASIDE="$TAKE_DIR.failed-$(date +%s)"; mv "$TAKE_DIR" "$ASIDE" && say "previous failed take moved to $ASIDE"
  else
    die "$TAKE_DIR already exists and is not a failed take (pick another --take; takes are never overwritten)"
  fi
fi
mkdir -p "$TAKE_DIR"
say "beat $BEAT take $TAKE -> $TAKE_DIR"

# ---------- always stop the host ----------
STOPPED=0
SRC="$MEDIA/$NAME/$BEAT"
cleanup() {
  local rc=$?
  trap - EXIT
  if [[ $STOPPED -eq 0 ]]; then
    say "stopping host (cleanup)"
    node "$RIG/stop.mjs" --name "$NAME" || say "WARNING: stop.mjs reported a problem; check: lsof -iTCP:$DASH_PORT,$CDP_PORT,$CTL_PORT -sTCP:LISTEN"
  fi
  # The take's own agent-browser daemon (socket dir inside the take): stopped by its VERIFIED pid only, never via `close`.
  if [[ -d "$TAKE_DIR/ab/sock" ]]; then
    node "$RIG/ab-daemon.mjs" stop --take-dir "$TAKE_DIR" || say "WARNING: could not verify/stop the take's agent-browser daemon; see $TAKE_DIR/ab/sock/*.pid"
  fi
  if [[ $rc -ne 0 ]]; then
    # Keep the evidence IN the take dir: whatever the rig produced (partial video, events, human-error screenshot).
    for f in "$SRC"/*; do [[ -f "$f" && ! -e "$TAKE_DIR/$(basename "$f")" ]] && cp "$f" "$TAKE_DIR/" 2>/dev/null; done
    { echo "exit $rc"; echo "reason: ${FAIL_REASON:-interrupted or unexpected error}"; date -u +%FT%TZ; } > "$TAKE_DIR/FAILED"
    say "FAILED (exit $rc). Evidence kept in $TAKE_DIR (host.log, actor.log/jsonl, partial video/events if recorded). Retry with the same --take $TAKE."
  fi
  exit $rc
}
trap cleanup EXIT
trap 'exit 130' INT TERM

CTL=(node "$RIG/ctl.mjs" --name "$NAME")

# ---------- reset -> host -> READY ----------
node "$RIG/reset.mjs" --name "$NAME" --model "$MODEL" ${RESET_FLAGS[@]+"${RESET_FLAGS[@]}"} || die "reset failed"
nohup node "$RIG/host.mjs" --beat "$BEAT" --name "$NAME" --port $DASH_PORT --cdp-port $CDP_PORT --control-port $CTL_PORT \
  >"$TAKE_DIR/host.log" 2>&1 </dev/null &
HOST_PID=$!
say "host pid $HOST_PID, waiting for READY (preState imports statements and runs /categorize on $MODEL; can take minutes)"
DEADLINE=$((SECONDS + 1800))
until grep -q '^READY ' "$TAKE_DIR/host.log" 2>/dev/null; do
  kill -0 $HOST_PID 2>/dev/null || { tail -20 "$TAKE_DIR/host.log" >&2; die "host exited before READY"; }
  [[ $SECONDS -lt $DEADLINE ]] || die "timed out waiting for READY"
  sleep 2
done
say "$(grep '^READY ' "$TAKE_DIR/host.log")"

# ---------- record: human in the background, real agent in the foreground ----------
"${CTL[@]}" start-recording >/dev/null || die "start-recording failed"
"${CTL[@]}" run-human >/dev/null || die "run-human failed"
# Sync only: the agent is started once the human has granted tools on camera (a tab with zero grants has nothing to list).
"${CTL[@]}" wait grants-applied 180000 >/dev/null || die "human never reached grants-applied (see $TAKE_DIR/host.log)"
say "grants applied; starting the agent"
SESSION="abt${TAKE}-$(( RANDOM % 9000 + 1000 ))-$$"   # unique per take; the daemon's files live in $TAKE_DIR/ab/sock
node "$RIG/ab-daemon.mjs" preflight --take-dir "$TAKE_DIR" || die "take socket dir already has a live agent-browser daemon"
# Actor timeout: --actor-timeout, else the beat's meta.actorTimeoutS, else 600 s.
if [[ -z "$ACTOR_TIMEOUT_S" ]]; then
  ACTOR_TIMEOUT_S="$(node -e "import('$RIG/beats/$BEAT.mjs').then(m=>console.log(m.meta?.actorTimeoutS ?? 600))" 2>/dev/null)"
fi
[[ "$ACTOR_TIMEOUT_S" =~ ^[0-9]+$ ]] || die "bad actor timeout: $ACTOR_TIMEOUT_S"
node "$RIG/actor.mjs" --beat "$BEAT" --take-dir "$TAKE_DIR" --cdp-port $CDP_PORT --session "$SESSION" --timeout-s "$ACTOR_TIMEOUT_S"
ACTOR_RC=$?
# Tell the human script the agent is done, so it sweeps any last card and then shows the ledger.
"${CTL[@]}" event actor-exited "{\"rc\":$ACTOR_RC}" >/dev/null 2>&1 || true
if [[ $ACTOR_RC -ne 0 ]]; then
  case $ACTOR_RC in 2) W="actor setup problem";; 3) W="actor timed out";; 5) W="actor ran a command outside the allowed set, or its stream did not match ab-audit.jsonl (policy violation)";; 6) W="agent-browser daemon could not be verified as the take's own";; *) W="claude failed or reported an error";; esac
  die "$W (exit $ACTOR_RC). See $TAKE_DIR/actor.log, ab-audit.jsonl and actor.jsonl"
fi
"${CTL[@]}" wait beat-end 180000 >/dev/null || {
  "${CTL[@]}" events 2>/dev/null | grep -A3 'human-script-error' | head -8 >&2
  die "beat did not end (human script stuck or errored; agent may not have proposed anything the human script accepts)"
}

# ---------- stop (CFR mp4), copy artifacts, keyframes ----------
node "$RIG/stop.mjs" --name "$NAME"; STOPRC=$?
STOPPED=1
[[ $STOPRC -eq 0 ]] || die "stop.mjs failed"
for f in video.mp4 events.json; do [[ -s "$SRC/$f" ]] || die "missing $SRC/$f after stop"; cp "$SRC/$f" "$TAKE_DIR/$f"; done
node "$RIG/keyframes.mjs" --beat "$BEAT" --name "$NAME" --out "$TAKE_DIR/frames" >/dev/null || die "keyframes failed"
FRAMES=$(ls "$TAKE_DIR/frames" | wc -l | tr -d ' ')

# ---------- compose ----------
CUT=""
if [[ $RENDER -eq 1 ]]; then
  HF="$TAKE_DIR/hf"   # per-take build dir: shared template in compose/hyperframes, beat copy in compose/beats/$BEAT.json
  node "$DEMOS/compose/hyperframes/build.mjs" --take "$TAKE_DIR" --config "$DEMOS/compose/beats/$BEAT.json" --out "$HF" || die "HyperFrames build failed"
  ( cd "$HF" && HYPERFRAMES_SKIP_SKILLS=1 npx --yes hyperframes@0.8.123 telemetry disable >/dev/null 2>&1 || true
    HYPERFRAMES_SKIP_SKILLS=1 npx --yes hyperframes@0.8.123 render --quiet -o "$TAKE_DIR/cut.mp4" ) || die "HyperFrames render failed"
  CUT="$TAKE_DIR/cut.mp4"
fi

say "done."
echo "  take dir  : $TAKE_DIR"
echo "  footage   : $TAKE_DIR/video.mp4"
echo "  events    : $TAKE_DIR/events.json"
echo "  transcript: $TAKE_DIR/actor.log  (source of truth: ab-audit.jsonl; model stream: actor.jsonl)"
echo "  keyframes : $TAKE_DIR/frames ($FRAMES stills)"
[[ -n "$CUT" ]] && echo "  cut       : $CUT"
exit 0
