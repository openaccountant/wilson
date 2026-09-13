#!/usr/bin/env zsh
zmodload zsh/datetime   # provides $EPOCHREALTIME
export PATH="$HOME/.bun/bin:$PATH"
cd "$(cd "$(dirname "$0")/../.." && pwd)" || exit 1
run(){ bun run src/index.tsx --profile demo --run "$1" 2>/dev/null; }

echo "### prewarm ###"
curl -s http://127.0.0.1:11434/api/generate -d '{"model":"granite4.1:8b","prompt":"hi","keep_alive":"20m","stream":false}' >/dev/null

beat(){ # label | prompt
  echo "==================== $1 ===================="
  local t0=$EPOCHREALTIME
  local out; out="$(run "$2")"
  local t1=$EPOCHREALTIME
  printf '⏱  %.1fs\n' "$((t1-t0))"
  print -r -- "$out" | grep -qiE '\{|\}|```|"action"|json' && echo '⚠️  JSON/CODE LEAK' || echo '✓ no json'
  printf 'lines: %d\n' "$(print -r -- "$out" | wc -l)"
  print -r -- "$out"
  echo
}

beat "B1 anomalies"  "Scan my transactions for duplicate charges using the anomaly tool."
beat "B5 entity OLD" "Use the entity classification tool to identify the real business entity behind MEGAMART ONLINE."
beat "B5 entity NEW" "Use the entity classification tool on MEGAMART ONLINE. Answer in one plain sentence stating the entity type and confidence. Do not output JSON, code blocks, or instructions."
beat "B6 verdict"    "Using only the duplicate charges and recurring charges already found, name the top 2 money-saving actions and the exact dollar amount each saves. Do not introduce any new transactions. Keep it to 2 short bullet points."
echo "ALL_DONE"
