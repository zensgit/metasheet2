#!/usr/bin/env bash
set -euo pipefail

# staging-health-loop.sh
# Quick multi-sample health latency probe for staging.
# Usage: STAGING_BASE_URL=https://staging.example.com ./scripts/staging-health-loop.sh [samples]
# Default samples: 5

SAMPLES=${1:-5}
URL="${STAGING_BASE_URL:-}"
if [ -z "$URL" ]; then
  echo "STAGING_BASE_URL not set" >&2; exit 1
fi

total=0
fail=0
min_ms=""
max_ms=0

echo "[health-loop] probing $URL/health ($SAMPLES samples)" >&2
for i in $(seq 1 $SAMPLES); do
  start_ns=$(date +%s%N || date +%s) 2>/dev/null
  if curl -fsS "$URL/health" -o /dev/null; then
    end_ns=$(date +%s%N || date +%s) 2>/dev/null
    # Convert nanoseconds to ms if available
    if [[ "$start_ns" =~ N$ ]] || [[ "$end_ns" =~ N$ ]]; then
      dur=0
    else
      if [ ${#start_ns} -gt 10 ]; then
        dur=$(( (end_ns - start_ns) / 1000000 ))
      else
        dur=$(( (end_ns - start_ns) * 1000 ))
      fi
    fi
    total=$((total+dur))
    if [ -z "$min_ms" ] || [ $dur -lt $min_ms ]; then min_ms=$dur; fi
    if [ $dur -gt $max_ms ]; then max_ms=$dur; fi
    printf "[%d] %d ms\n" "$i" "$dur"
  else
    echo "[$i] FAIL" >&2
    fail=$((fail+1))
  fi
  sleep 1
done

ok=$((SAMPLES-fail))
avg=0
if [ $ok -gt 0 ]; then avg=$((total/ok)); fi

status="GREEN"
if [ $avg -gt 150 ]; then status="YELLOW"; fi
if [ $avg -gt 250 ]; then status="RED"; fi

echo "Summary: ok=$ok fail=$fail avg=${avg}ms min=${min_ms:-0}ms max=${max_ms}ms status=$status" | tee /dev/stderr

if [ $fail -gt 0 ]; then exit 1; fi
exit 0
