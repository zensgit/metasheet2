#!/usr/bin/env bash
set -euo pipefail

# metrics-diff.sh local.prom.txt staging.prom.txt
# Compares key counters / histograms presence & changes.

if [ "$#" -lt 2 ]; then
  echo "Usage: $0 <local_metrics_file> <staging_metrics_file>" >&2
  exit 1
fi

LOCAL=$1
STAGING=$2

keys=(snapstats_latency snapshot_create_total protection_rule_eval_total http_errors_total rate_limit_triggered_total)

get_val() {
  # simplistic extraction: first match line numeric tail
  grep -E "^$1" "$2" | awk '{for(i=1;i<=NF;i++){if($i ~ /^[0-9]+(\.[0-9]+)?$/){print $i; exit}}}'
}

echo "Metric,Local,Staging,Delta" > metrics-diff.csv
for k in "${keys[@]}"; do
  lv=$(get_val "$k" "$LOCAL" || true)
  sv=$(get_val "$k" "$STAGING" || true)
  [ -z "$lv" ] && lv=0
  [ -z "$sv" ] && sv=0
  if [[ $lv =~ ^[0-9] && $sv =~ ^[0-9] ]]; then
    delta=$(awk -v a=$lv -v b=$sv 'BEGIN{printf "%.2f", (b-a)}')
  else
    delta=NA
  fi
  echo "$k,$lv,$sv,$delta" >> metrics-diff.csv
done

echo "[metrics-diff] written metrics-diff.csv" >&2
cat metrics-diff.csv

