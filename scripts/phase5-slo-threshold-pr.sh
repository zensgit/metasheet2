#!/usr/bin/env bash
set -euo pipefail
# Generate patch for thresholds file based on suggestions JSON.
# Usage: scripts/phase5-slo-threshold-pr.sh <suggestions.json> <thresholds-file> <out-patch>

SUG="${1:-claudedocs/PHASE5_SLO_SUGGESTIONS.json}"; THR="${2:-scripts/phase5-thresholds.json}"; OUT="${3:-/tmp/phase5-thresholds.patch}";
[[ -f "$SUG" ]] || { echo "Suggestions JSON not found: $SUG" >&2; exit 1; }
[[ -f "$THR" ]] || { echo "Thresholds file not found: $THR" >&2; exit 1; }

command -v jq >/dev/null 2>&1 || { echo "jq required" >&2; exit 2; }

tmp=$(mktemp)
cp "$THR" "$tmp"

count=$(jq '.suggestions | length' "$SUG")
if (( count == 0 )); then
  echo "No suggestions to apply" >&2; exit 0
fi

for row in $(jq -c '.suggestions[]' "$SUG"); do
  metric=$(echo "$row" | jq -r '.metric')
  proposed=$(echo "$row" | jq -r '.suggested_threshold')
  case "$metric" in
    plugin_reload_latency_p95)
      jq --argjson v "$proposed" '.plugin_reload.p95_threshold=$v' "$tmp" > "$tmp.new" && mv "$tmp.new" "$tmp" ;;
    snapshot_create_latency_p95)
      jq --argjson v "$proposed" '.snapshot.create.p95_threshold=$v' "$tmp" > "$tmp.new" && mv "$tmp.new" "$tmp" ;;
    snapshot_restore_latency_p95)
      jq --argjson v "$proposed" '.snapshot.restore.p95_threshold=$v' "$tmp" > "$tmp.new" && mv "$tmp.new" "$tmp" ;;
    redis_get_p95)
      jq --argjson v "$proposed" '.redis.get.p95_threshold=$v' "$tmp" > "$tmp.new" && mv "$tmp.new" "$tmp" ;;
    redis_set_p95)
      jq --argjson v "$proposed" '.redis.set.p95_threshold=$v' "$tmp" > "$tmp.new" && mv "$tmp.new" "$tmp" ;;
    *) echo "Unknown metric $metric; skipping" >&2 ;;
  esac
done

diff -u "$THR" "$tmp" > "$OUT" || true
echo "[slo-pr] Patch written to $OUT"
cat "$OUT"
