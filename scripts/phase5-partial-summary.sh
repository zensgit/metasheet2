#!/usr/bin/env bash
# Generate partial summary for Phase 5 observation metrics.csv
# Usage: bash scripts/phase5-partial-summary.sh results/phase5-20251122-150047/metrics.csv
set -euo pipefail
CSV="${1:-results/phase5-20251122-150047/metrics.csv}"
[ -f "$CSV" ] || { echo "No metrics.csv found: $CSV" >&2; exit 1; }
OUT_DIR="$(dirname "$CSV")"
OUT_FILE="$OUT_DIR/partial-summary.md"
samples=$(tail -n +2 "$CSV" | wc -l | tr -d ' ')
if [ "$samples" -lt 2 ]; then
  echo "Not enough samples ($samples) for partial summary" >&2
  exit 0
fi
awk -F',' 'NR==1{next}{s+=$2; if(mins==0||$2<mins)mins=$2; if($2>maxs)maxs=$2; p+=$3; if(minp==0||$3<minp)minp=$3; if($3>maxp)maxp=$3; f+=$4; if(minf==0||$4<minf)minf=$4; if($4>maxf)maxf=$4}END{printf "# Phase 5 Partial Summary\n\nSamples: %d\n\n## HTTP Success Rate\nMin: %.2f (%.2f%%)\nMax: %.2f (%.2f%%)\nAvg: %.4f (%.2f%%)\n\n## P99 Latency\nMin: %.3fs\nMax: %.3fs\nAvg: %.3fs\n\n## Fallback Ratio\nMin: %.2f (%.2f%%)\nMax: %.2f (%.2f%%)\nAvg: %.4f (%.2f%%)\n", samples, mins, mins*100, maxs, maxs*100, s/samples, (s/samples)*100, minp, maxp, p/samples, minf, minf*100, maxf, maxf*100, f/samples, (f/samples)*100 }' "$CSV" > "$OUT_FILE"
echo "Partial summary written: $OUT_FILE" >&2
