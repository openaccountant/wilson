#!/usr/bin/env zsh
# ============================================================================
#  verify-accuracy.sh — does the CURRENT demo-profile model answer TRUTHFULLY?
#  Runs the demo's key prompts headless (--run) and checks each answer against
#  ground truth. Catches the granite-3b-style hallucination automatically.
#
#  Usage:  ./data/demo/verify-accuracy.sh
#  Safe:   refuses to run if a wilson process is already active (avoids collision).
# ============================================================================
export PATH="$HOME/.bun/bin:$PATH"
cd /Users/jdfiscus/dev/oss/openaccoutant/wilson || exit 1

if pgrep -f "src/index.tsx" >/dev/null; then
  echo "✗ A wilson process is running. Wait for it to finish, then re-run."; exit 1
fi

MODEL=$(grep -o 'ollama:[^"]*' ~/.openaccountant/profiles/demo/settings.json 2>/dev/null)
echo "=== Verifying model: ${MODEL} ==="
echo "=== Data: $(sqlite3 ~/.openaccountant/profiles/demo/data.db 'SELECT COUNT(*) FROM transactions;') txns, $(sqlite3 ~/.openaccountant/profiles/demo/data.db 'SELECT MIN(date)||" → "||MAX(date) FROM transactions;') ==="
echo ""

run() { bun run src/index.tsx --profile demo --run "$1" 2>/dev/null; }
pass=0; fail=0
check() { # desc | haystack | needle(must contain)
  if print -r -- "$2" | grep -iqF -- "$3"; then echo "  ✓ $1"; ((pass++)); else echo "  ✗ $1 (missing: $3)"; ((fail++)); fi
}
refute() { # desc | haystack | needle(must NOT contain = hallucination)
  if print -r -- "$2" | grep -iqF -- "$3"; then echo "  ✗ HALLUCINATION $1 (found fabricated: $3)"; ((fail++)); else echo "  ✓ $1 (no '$3')"; ((pass++)); fi
}

echo "--- [1/3] Anomaly scan (deterministic; should be rock-solid) ---"
A=$(run "Scan my transactions for duplicate charges using the anomaly tool.")
print -r -- "$A" | tail -12
check "found MEGAMART duplicate"  "$A" "MEGAMART"
check "found \$89.99 amount"       "$A" "89.99"
check "found HARBORVIEW duplicate" "$A" "HARBORVIEW"
echo ""

echo "--- [2/3] Subscriptions (reasoning; the beat 3b failed) ---"
S=$(run "List my recurring subscription charges and the total monthly cost. Use only the transactions in the database.")
print -r -- "$S" | tail -12
check  "names SKYSTREAM"  "$S" "SKYSTREAM"
check  "names STREAMFLIX" "$S" "STREAMFLIX"
check  "names CLOUDVAULT" "$S" "CLOUDVAULT"
refute "no fabricated Netflix"  "$S" "Netflix"
refute "no fabricated Spotify"  "$S" "Spotify"
refute "no fabricated Stitcher" "$S" "Stitcher"
echo ""

echo "--- [3/3] Spending summary (deterministic) ---"
P=$(run "Give me a spending summary for August 2026.")
print -r -- "$P" | tail -10
check "references August / a total" "$P" "August"
echo ""

echo "============================================================"
echo "  RESULT for ${MODEL}:  ${pass} passed, ${fail} failed"
[ "$fail" -eq 0 ] && echo "  ✅ TRUSTWORTHY for the demo" || echo "  ⚠️  ${fail} failure(s) — inspect above before demoing on this model"
echo "============================================================"
