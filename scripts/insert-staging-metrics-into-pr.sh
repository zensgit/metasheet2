#!/usr/bin/env bash
set -euo pipefail

# Inserts staging performance metrics into PR description draft at marker:
# <!-- STAGING_METRICS_INSERT -->
# Usage:
#   bash scripts/insert-staging-metrics-into-pr.sh <perf_summary_json> <error_rate> <p50> <p95> <p99> <max>

FILE="docs/sprint2/pr-description-draft.md"
MARK="<!-- STAGING_METRICS_INSERT -->"

if [[ $# -lt 6 ]]; then
  echo "Usage: $0 <summary.json> <error_rate> <p50> <p95> <p99> <max>" >&2
  exit 2
fi

summary=$1; err_rate=$2; p50=$3; p95=$4; p99=$5; maxv=$6
if [[ ! -f "$summary" ]]; then
  echo "Summary file not found: $summary" >&2; exit 2
fi

metrics_block=$(cat <<EOF
### Staging Performance Metrics (Auto-Inserted)
| Metric | Value | Target | Status |
|--------|-------|--------|--------|
| P50 | ${p50}ms | n/a | ✅ |
| P95 | ${p95}ms | ≤150ms | $([[ $p95 -le 150 ]] && echo "✅" || echo "🔴") |
| P99 | ${p99}ms | ≤250ms | $([[ $p99 -le 250 ]] && echo "✅" || echo "🔴") |
| Max | ${maxv}ms | <500ms | $([[ $maxv -le 500 ]] && echo "✅" || echo "⚠️") |
| Error Rate | ${err_rate}% | <1% | $([[ $(echo "$err_rate < 1" | bc -l) == 1 ]] && echo "✅" || echo "🔴") |
| Artifact | $(basename "$summary") | - | 📎 |
EOF
)

tmp=$(mktemp)
awk -v mark="$MARK" -v block="$metrics_block" 'BEGIN{printed=0} {
  print $0
  if (index($0, mark)>0 && printed==0) { print block; printed=1 }
}' "$FILE" > "$tmp"
mv "$tmp" "$FILE"
echo "Inserted staging metrics block into $FILE"

