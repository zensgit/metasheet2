#!/usr/bin/env bash
set -euo pipefail

# Post-staging finalize helper
# - Extracts metrics from staging perf summary JSON
# - Inserts metrics into PR draft at <!-- STAGING_METRICS_INSERT -->
# - Optionally updates the live PR body via gh CLI
#
# Usage:
#   bash scripts/post-staging-finalize.sh [path/to/staging-perf.summary.json]

PERF_DIR="docs/sprint2/performance"
DEFAULT_FILE="$PERF_DIR/staging-perf.summary.json"
SUMMARY_FILE=${1:-}

choose_summary() {
  if [[ -n "$SUMMARY_FILE" && -f "$SUMMARY_FILE" ]]; then
    echo "$SUMMARY_FILE"; return 0
  fi
  if [[ -f "$DEFAULT_FILE" ]]; then
    echo "$DEFAULT_FILE"; return 0
  fi
  # Fallback to latest staging*summary.json
  latest=$(ls -1t "$PERF_DIR"/*staging*summary.json 2>/dev/null | head -n1 || true)
  if [[ -n "$latest" && -f "$latest" ]]; then
    echo "$latest"; return 0
  fi
  echo ""; return 1
}

file=$(choose_summary || true)
if [[ -z "$file" ]]; then
  echo "❌ Could not locate staging performance summary JSON." >&2
  exit 2
fi

# Parse metrics using Python (tolerant to different field casings)
read -r err p50 p95 p99 maxv <<< "$(python3 - "$file" <<'PY'
import sys, json
path=sys.argv[1]
with open(path,'r') as f:
    data=json.load(f)

def get(*keys, default=None):
    for k in keys:
        if k in data: return data[k]
    # nested common shapes
    stats=data.get('stats') or data.get('summary') or {}
    for k in keys:
        if k in stats: return stats[k]
    return default

p50=get('p50','P50','median', default=0)
p95=get('p95','P95', default=0)
p99=get('p99','P99', default=0)
maxv=get('max','Max', default=0)
err=get('errors','error_rate','errorRate','Errors', default=0)

def to_num(v):
    try:
        return float(v)
    except Exception:
        try:
            return float(str(v).strip('%'))
        except Exception:
            return 0.0

p50=to_num(p50)
p95=to_num(p95)
p99=to_num(p99)
maxv=to_num(maxv)
err=to_num(err)

# Heuristic: if error rate looks like fraction (<=1), convert to %
if err<=1.0:
    err = err*100.0

# Round to integers for display
print(int(round(err)), int(round(p50)), int(round(p95)), int(round(p99)), int(round(maxv)))
PY
" )"

echo "[post-staging-finalize] Summary: $file"
echo "[post-staging-finalize] Metrics: err=${err}% p50=${p50}ms p95=${p95}ms p99=${p99}ms max=${maxv}ms"

bash scripts/insert-staging-metrics-into-pr.sh "$file" "$err" "$p50" "$p95" "$p99" "$maxv"

# Try to push PR body via gh CLI
if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  prnum=$(gh pr view --json number -q .number 2>/dev/null || echo "")
  if [[ -n "$prnum" ]]; then
    gh pr edit "$prnum" --body "$(cat docs/sprint2/pr-description-draft.md)" || true
    gh pr comment "$prnum" --body "📊 Inserted staging performance metrics: P95=${p95}ms, P99=${p99}ms, ErrorRate=${err}% (artifact: $(basename "$file"))." || true
    echo "[post-staging-finalize] PR #$prnum updated."
  else
    echo "[post-staging-finalize] No PR detected via gh; skipped remote update."
  fi
else
  echo "[post-staging-finalize] gh CLI not available/authenticated; updated draft file only."
fi

echo "[post-staging-finalize] Done."

