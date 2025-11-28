#!/usr/bin/env bash
set -euo pipefail

# Cache pattern audit: reads metrics endpoint, aggregates hit/miss counts per key_pattern
# and outputs patterns with low hit rate or high misses.
# Usage: scripts/phase5-cache-audit.sh <metrics_url> [min-total=50] [max-hit-rate=70]

METRICS_URL="${1:-http://localhost:8901/metrics/prom}"
MIN_TOTAL="${2:-50}"          # Only consider patterns with total >= MIN_TOTAL
MAX_HIT_RATE="${3:-70}"       # Report patterns with hit rate <= MAX_HIT_RATE

TMP=$(mktemp)
curl -sf "$METRICS_URL" > "$TMP" || { echo "Failed to fetch metrics from $METRICS_URL" >&2; exit 1; }

declare -A hits misses

while read -r line; do
  if [[ $line =~ cache_hits_total\{impl="([^"]+)",key_pattern="([^"]+)"\}\ ([0-9]+) ]]; then
    impl="${BASH_REMATCH[1]}"; key="${BASH_REMATCH[2]}"; val="${BASH_REMATCH[3]}"
    hits["$impl:$key"]=$val
  elif [[ $line =~ cache_miss_total\{impl="([^"]+)",key_pattern="([^"]+)"\}\ ([0-9]+) ]]; then
    impl="${BASH_REMATCH[1]}"; key="${BASH_REMATCH[2]}"; val="${BASH_REMATCH[3]}"
    misses["$impl:$key"]=$val
  fi
done < "$TMP"

printf "[cache-audit] impl:key_pattern hits misses hit_rate total candidate\n"

for k in "${!hits[@]}"; do
  h=${hits[$k]:-0}
  m=${misses[$k]:-0}
  total=$((h+m))
  if (( total < MIN_TOTAL )); then continue; fi
  rate=0
  if (( total > 0 )); then
    rate=$(awk -v h="$h" -v t="$total" 'BEGIN{ printf("%.2f", (h/t)*100) }')
  fi
  candidate="false"
  if awk -v r="$rate" -v th="$MAX_HIT_RATE" 'BEGIN{exit !(r<=th)}'; then
    candidate="true"
  fi
  printf "[audit] %s %d %d %s%% %d %s\n" "$k" "$h" "$m" "$rate" "$total" "$candidate"
done | sort -t' ' -k5 -n

rm -f "$TMP"
