#!/usr/bin/env bash
set -euo pipefail

# Generate SLO tightening suggestions based on recent latency improvements.
# Usage: scripts/phase5-slo-tighten-suggestions.sh <nightly-json-dir> <out-json> [window_days]
# Default window_days=30.
# Logic:
#  - Collect p95 values for plugin reload, snapshot create/restore, redis get/set.
#  - Compute median observed p95 over window.
#  - If median < (current_threshold * 0.9), suggest new_threshold = round(median * 1.15, 2) (retain headroom).
#  - Output JSON with suggestions. Skip metrics with <5 samples or missing data.

SRC_DIR="${1:-results/nightly}"
OUT_JSON="${2:-claudedocs/PHASE5_SLO_SUGGESTIONS.json}"
WINDOW_DAYS="${3:-30}"

command -v jq >/dev/null 2>&1 || { echo "jq required" >&2; exit 2; }

if [[ ! -d "$SRC_DIR" ]]; then
  echo "Source directory not found: $SRC_DIR" >&2; exit 1
fi

now_epoch=$(date +%s)
cutoff_epoch=$(( now_epoch - WINDOW_DAYS*24*3600 ))

files=( )
while IFS= read -r f; do files+=("$f"); done < <(find "$SRC_DIR" -maxdepth 1 -name 'phase5-*.json' -type f -printf '%T@ %p\n' 2>/dev/null | sort -nr | awk -v c="$cutoff_epoch" '{ if ($1 >= c) print $2 }')

if [[ ${#files[@]} -eq 0 ]]; then
  echo "No JSON files in window" >&2; exit 1
fi

declare -A current_thresholds=(
  [plugin_reload_latency_p95]=2
  [snapshot_create_latency_p95]=5
  [snapshot_restore_latency_p95]=5
  [redis_get_p95]=0.05
  [redis_set_p95]=0.05
)

declare -A metric_keys=(
  [plugin_reload_latency_p95]='.percentiles["metasheet_plugin_reload_duration_seconds{plugin_name=\"example-plugin\"}"].p95'
  [snapshot_create_latency_p95]='.percentiles["metasheet_snapshot_operation_duration_seconds{operation=\"create\"}"].p95'
  [snapshot_restore_latency_p95]='.percentiles["metasheet_snapshot_operation_duration_seconds{operation=\"restore\"}"].p95'
  [redis_get_p95]='.percentiles["redis_operation_duration_seconds{op=\"get\"}"].p95'
  [redis_set_p95]='.percentiles["redis_operation_duration_seconds{op=\"set\"}"].p95'
)

median() { awk '{a[NR]=$1} END { if (NR==0){print ""; exit}; asort(a); mid=int((NR+1)/2); if (NR%2){print a[mid];} else {print (a[mid]+a[mid-1])/2} }' ; }

suggestions='[]'

for m in "${!metric_keys[@]}"; do
  key=${metric_keys[$m]}
  values=( )
  samples=0
  for f in "${files[@]}"; do
    v=$(jq -r "$key // empty" "$f")
    if [[ -n "$v" && "$v" != "0" ]]; then
      values+=("$v")
      samples=$((samples+1))
    fi
  done
  if [[ $samples -lt 5 ]]; then
    continue
  fi
  med=$(printf '%s\n' "${values[@]}" | median)
  cur=${current_thresholds[$m]:-}
  if [[ -z "$cur" || -z "$med" ]]; then
    continue
  fi
  # improvement condition: median < 0.9 * current threshold
  improve=$(awk -v med="$med" -v cur="$cur" 'BEGIN{print (med < (cur*0.9)) ? 1 : 0}')
  if [[ "$improve" == "1" ]]; then
    new=$(awk -v med="$med" 'BEGIN{printf("%.2f", med*1.15)}')
    suggestions=$(echo "$suggestions" | jq -c --arg metric "$m" --argjson current "$cur" --argjson median "$med" --argjson proposed "$new" --argjson count "$samples" '. + [{metric:$metric,current_threshold:$current,median_observed:$median,suggested_threshold:$proposed,sample_count:$count}]')
  fi
done

cat > "$OUT_JSON" <<EOF
{
  "generated_at": "$(date -u '+%Y-%m-%dT%H:%M:%SZ')",
  "window_days": $WINDOW_DAYS,
  "file_count": ${#files[@]},
  "suggestions": $suggestions
}
EOF

echo "[tighten] Suggestions written to $OUT_JSON (count: $(echo "$suggestions" | jq 'length'))"
