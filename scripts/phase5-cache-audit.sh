#!/usr/bin/env bash
set -euo pipefail

# Cache pattern audit: reads metrics endpoint, aggregates hit/miss counts per key_pattern
# and outputs patterns with low hit rate or high misses.
# Usage: scripts/phase5-cache-audit.sh <metrics_url> [min-total=50] [max-hit-rate=70]

METRICS_URL="${1:-http://localhost:8901/metrics/prom}"
MIN_TOTAL="${2:-50}"          # Only consider patterns with total >= MIN_TOTAL
MAX_HIT_RATE="${3:-70}"       # Report patterns with hit rate <= MAX_HIT_RATE

TMP=$(mktemp)
CURL_ARGS=(-sf)
AUTH_HEADER="${METRICS_AUTH_HEADER:-${EXTRA_CURL_HEADER:-}}"
if [ -n "$AUTH_HEADER" ]; then
  CURL_ARGS+=(-H "$AUTH_HEADER")
fi
curl "${CURL_ARGS[@]}" "$METRICS_URL" > "$TMP" || { echo "Failed to fetch metrics from $METRICS_URL" >&2; exit 1; }

keys=()
hits=()
misses=()
HIT_RE='cache_hits_total\{impl="([^"]+)",key_pattern="([^"]+)"\} ([0-9]+)'
MISS_RE='cache_miss_total\{impl="([^"]+)",key_pattern="([^"]+)"\} ([0-9]+)'

set_count() {
  local key="$1"
  local kind="$2"
  local value="$3"
  local idx=-1
  local i

  for ((i=0; i<${#keys[@]}; i++)); do
    if [ "${keys[$i]}" = "$key" ]; then
      idx=$i
      break
    fi
  done

  if [ "$idx" -lt 0 ]; then
    keys+=("$key")
    hits+=(0)
    misses+=(0)
    idx=$((${#keys[@]} - 1))
  fi

  if [ "$kind" = "hit" ]; then
    hits[$idx]="$value"
  else
    misses[$idx]="$value"
  fi
}

while read -r line; do
  if [[ $line =~ $HIT_RE ]]; then
    impl="${BASH_REMATCH[1]}"; key="${BASH_REMATCH[2]}"; val="${BASH_REMATCH[3]}"
    set_count "$impl:$key" hit "$val"
  elif [[ $line =~ $MISS_RE ]]; then
    impl="${BASH_REMATCH[1]}"; key="${BASH_REMATCH[2]}"; val="${BASH_REMATCH[3]}"
    set_count "$impl:$key" miss "$val"
  fi
done < "$TMP"

printf "[cache-audit] impl:key_pattern hits misses hit_rate total candidate\n"

for ((i=0; i<${#keys[@]}; i++)); do
  k=${keys[$i]}
  h=${hits[$i]:-0}
  m=${misses[$i]:-0}
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
