#!/usr/bin/env bash
set -euo pipefail

# perf-diff.sh local-summary.json staging-summary.json
# Compares latency stats (p50,p95,p99,max,errors) and outputs CSV + MD.

if [ "$#" -lt 2 ]; then
  echo "Usage: $0 <local_perf_summary.json> <staging_perf_summary.json> [output-dir]" >&2
  exit 1
fi

LOCAL=$1
STAGING=$2
OUT_DIR=${3:-docs/sprint2/performance}
TS=$(date +%Y%m%d-%H%M%S)
mkdir -p "$OUT_DIR"
OUT_CSV="$OUT_DIR/perf-diff-$TS.csv"
OUT_MD="$OUT_DIR/perf-diff-$TS.md"

metric_keys=(p50 p95 p99 max errors)

get_val() {
  jq -r --arg k "$1" '.[$k] // .[($k|ascii_upcase)] // 0' "$2" 2>/dev/null || echo 0
}

echo "metric,local,staging,delta,delta_pct" > "$OUT_CSV"
for m in "${metric_keys[@]}"; do
  lv=$(get_val "$m" "$LOCAL")
  sv=$(get_val "$m" "$STAGING")
  # numeric check
  if [[ ! $lv =~ ^[0-9]+(\.[0-9]+)?$ ]]; then lv=0; fi
  if [[ ! $sv =~ ^[0-9]+(\.[0-9]+)?$ ]]; then sv=0; fi
  delta=$(awk -v a=$lv -v b=$sv 'BEGIN{printf "%.2f", (b-a)}')
  if [ "$lv" = 0 ]; then
    pct="0.00"
  else
    pct=$(awk -v a=$lv -v b=$sv 'BEGIN{printf "%.2f", ((b-a)/a)*100}')
  fi
  echo "$m,$lv,$sv,$delta,$pct" >> "$OUT_CSV"
done

cat > "$OUT_MD" <<EOF
# Performance Diff $TS

Base Local: $(basename "$LOCAL")
Staging   : $(basename "$STAGING")

| Metric | Local | Staging | Delta | Delta % |
|--------|-------|---------|-------|---------|
$(awk -F, 'NR>1 {printf "| %s | %s | %s | %s | %s%% |\n", $1,$2,$3,$4,$5}' "$OUT_CSV")

CSV: $OUT_CSV
EOF

echo "[perf-diff] written $OUT_CSV and $OUT_MD" >&2

