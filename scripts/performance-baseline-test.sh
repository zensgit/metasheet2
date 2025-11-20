#!/usr/bin/env bash
set -euo pipefail

API_TOKEN=${1:-}
BASE_URL=${2:-http://localhost:8900}
OUT_DIR="docs/sprint2/performance"
ROUNDS=${ROUNDS:-60}
ENDPOINT=${ENDPOINT:-"/api/v2/hello"}

if [[ -z "$API_TOKEN" ]]; then
  echo "Usage: $0 <API_TOKEN> [BASE_URL]" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"
CSV="$OUT_DIR/perf-$(date +%Y%m%d_%H%M%S).csv"
echo "ts,ms,status" > "$CSV"

ms_now() { python3 - << 'PY'
import time; print(int(time.time()*1000))
PY
}

for i in $(seq 1 $ROUNDS); do
  start=$(ms_now)
  code=$(curl -sS -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $API_TOKEN" "$BASE_URL$ENDPOINT" || echo 000)
  end=$(ms_now)
  dur=$((end-start))
  echo "$(date -Iseconds),$dur,$code" >> "$CSV"
  sleep 1
done

# Simple stats with awk
awk -F, 'NR>1{print $2}' "$CSV" | sort -n > "$CSV.sorted"
count=$(wc -l < "$CSV.sorted")
if [[ $count -gt 0 ]]; then
  p50_idx=$((count*50/100)); p95_idx=$((count*95/100)); p99_idx=$((count*99/100));
  p50=$(sed -n "${p50_idx}p" "$CSV.sorted")
  p95=$(sed -n "${p95_idx}p" "$CSV.sorted")
  p99=$(sed -n "${p99_idx}p" "$CSV.sorted")
  max=$(tail -n1 "$CSV.sorted")
  err=$(awk -F, 'NR>1 && $3 >= 400 {c++} END{print c+0}' "$CSV")
  printf '{"p50":%s,"p95":%s,"p99":%s,"max":%s,"errors":%s,"total":%s}\n' "${p50:-0}" "${p95:-0}" "${p99:-0}" "${max:-0}" "$err" "$count" > "$CSV.summary.json"
  echo "Summary: $(cat "$CSV.summary.json")"
fi

echo "Saved: $CSV"
