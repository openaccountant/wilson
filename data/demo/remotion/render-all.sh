#!/usr/bin/env zsh
# Composite every raw clip through Remotion (animated brand cards + end card).
# Run from the remotion dir. Reads raw mp4s from ../  (data/demo), writes ../final/.
set -e
export PATH="$HOME/.bun/bin:$PATH"
cd "$(dirname "$0")"
RAW=".."          # data/demo
OUTDIR="../final"; mkdir -p "$OUTDIR" public

# name | source mp4 | title | subtitle | speed
clips=(
  "hero|$RAW/boe-demo.mp4|CASE FILE: AUGUST 2026|Follow the money.|4"
  "sovereignty|$RAW/sovereignty.mp4|PRIVATE BY DESIGN|gemma4:31b - fully local|3"
  "orchestration|$RAW/orchestration.mp4|ONE COMMAND. A FULL AUDIT.|Autonomous, on-device|4"
  "flow1-import|$RAW/flow1-help-import.mp4|IMPORT IN SECONDS|/help - slash palette - import|3"
  "flow2-skill|$RAW/flow2-skill.mp4|SKILLS ON DEMAND|Browse the palette - run a skill|4"
  "flow3-budget|$RAW/flow3-budget.mp4|BUDGETS THAT TRACK|/budget - set - monitor|3"
  "goal|$RAW/flow-goal.mp4|SET A GOAL|Natural language - on-device|3"
  "dashboard-overview|$RAW/dash-video/overview.webm|THE OVERVIEW|Filters - heatmap - P&L|1.4"
  "dashboard-training|$RAW/dash-video/training.webm|TRAINING DATA|Annotate - rate - export (SFT/DPO)|1.4"
  "dashboard-goals|$RAW/dash-video/goals.webm|GOALS|Track progress visually|1.4"
  "dashboard-settings|$RAW/dash-video/settings.webm|SETTINGS|Profiles - entities - memory|1.4"
  "dashboard-chat|$RAW/dash-video/chat.webm|CHAT|Pick up a past conversation|1.4"
)

for c in "${clips[@]}"; do
  IFS='|' read -r name src title sub speed <<< "$c"
  [ -f "$src" ] || { echo "  skip $name (no $src)"; continue; }
  ext="${src##*.}"
  rm -f public/input.*
  cp "$src" "public/input.$ext"
  echo "=== render $name ==="
  bunx remotion render src/index.ts Clip "$OUTDIR/final-$name.mp4" \
    --props="{\"src\":\"input.$ext\",\"title\":\"$title\",\"subtitle\":\"$sub\",\"speed\":$speed}" 2>&1 | tail -2
done
echo "=== done -> $OUTDIR ==="
ls -1 "$OUTDIR"
