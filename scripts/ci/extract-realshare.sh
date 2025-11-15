#!/usr/bin/env bash
set -euo pipefail

FILE=${1:-metrics.txt}
if [ ! -f "$FILE" ]; then
  echo "metrics file not found: $FILE" >&2
  exit 1
fi

REAL=$(awk '/rbac_perm_queries_real_total/{print $2}' "$FILE" | head -1)
SYN=$(awk '/rbac_perm_queries_synth_total/{print $2}' "$FILE" | head -1)
HITS=$(awk '/rbac_perm_cache_hits_total/{print $2}' "$FILE" | head -1)
MISSES=$(awk '/rbac_perm_cache_misses_total/{print $2}' "$FILE" | head -1)

REAL=${REAL:-0}
SYN=${SYN:-0}
HITS=${HITS:-0}
MISSES=${MISSES:-0}
TOTAL_Q=$((REAL+SYN))
if [ "$TOTAL_Q" -gt 0 ]; then
  SHARE=$(awk -v r=$REAL -v s=$SYN 'BEGIN{ if(r+s>0) printf "%.2f", r/(r+s)*100; else print 0 }')
else
  SHARE=0
fi

ELIGIBLE="No"
if [ "$REAL" -gt 0 ] && [ "$SYN" -gt 0 ] && awk -v sh=$SHARE 'BEGIN{exit !(sh>=30)}'; then
  ELIGIBLE="Yes"
fi

echo "REAL=$REAL SYN=$SYN HITS=$HITS MISSES=$MISSES REALSHARE=${SHARE}% ELIGIBLE=$ELIGIBLE"
echo "REALSHARE_RESULT real=$REAL synth=$SYN realshare=${SHARE}% eligible=$ELIGIBLE"
