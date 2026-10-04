#!/usr/bin/env bash
# Stage cut of a take: build --profile stage, render with the pinned HyperFrames, hold the last frame, grab the poster.
#   demos/compose/hyperframes/stage.sh --take /private/tmp/claude-501/wilson-demos/<beat>/take<N> [--config <beat json>] [--publish <dir> --name <name>]
# Writes <take>/cut-stage.mp4 and <take>/cut-stage-poster.png (build dir <take>/hf-stage). With --publish, also copies them to
# <dir>/<name>.mp4 and <dir>/<name>-poster.png. The hold length and the poster time come from the build's stage.json.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
TAKE= CONFIG= PUB= NAME=
while [[ $# -gt 0 ]]; do
  case "$1" in
    --take) TAKE="$2"; shift 2;;
    --config) CONFIG="$2"; shift 2;;
    --publish) PUB="$2"; shift 2;;
    --name) NAME="$2"; shift 2;;
    *) echo "unknown arg $1" >&2; exit 2;;
  esac
done
[[ -n "$TAKE" ]] || { echo "usage: stage.sh --take <take dir> [--config <beat json>] [--publish <dir> --name <name>]" >&2; exit 2; }
[[ -z "$PUB" || -n "$NAME" ]] || { echo "--publish needs --name" >&2; exit 2; }
TAKE="$(cd "$TAKE" && pwd)"
OUT="$TAKE/hf-stage"
node "$HERE/build.mjs" --take "$TAKE" ${CONFIG:+--config "$CONFIG"} --profile stage --out "$OUT"
RAW="$OUT/render.mp4"
( cd "$OUT" && HYPERFRAMES_SKIP_SKILLS=1 npx --yes hyperframes@0.8.123 telemetry disable >/dev/null 2>&1 || true
  HYPERFRAMES_SKIP_SKILLS=1 npx --yes hyperframes@0.8.123 render --quiet -o "$RAW" )
HOLD="$(node -p "require('$OUT/stage.json').endHoldSeconds")"
POSTER="$(node -p "require('$OUT/stage.json').poster ?? ''")"
# the deck freezes on the last frame: clone it for HOLD seconds
ffmpeg -v error -y -i "$RAW" -vf "tpad=stop_mode=clone:stop_duration=$HOLD" -c:v libx264 -crf 16 -preset slow -pix_fmt yuv420p -movflags +faststart -an "$TAKE/cut-stage.mp4"
if [[ -n "$POSTER" ]]; then ffmpeg -v error -y -ss "$POSTER" -i "$RAW" -frames:v 1 "$TAKE/cut-stage-poster.png"; fi
echo "[stage] $TAKE/cut-stage.mp4 $(ffprobe -v error -show_entries format=duration -of csv=p=0 "$TAKE/cut-stage.mp4") s, poster at ${POSTER:-none} s"
if [[ -n "$PUB" ]]; then
  mkdir -p "$PUB"
  cp "$TAKE/cut-stage.mp4" "$PUB/$NAME.mp4"
  [[ -f "$TAKE/cut-stage-poster.png" ]] && cp "$TAKE/cut-stage-poster.png" "$PUB/$NAME-poster.png"
  echo "[stage] published $PUB/$NAME.mp4"
fi
