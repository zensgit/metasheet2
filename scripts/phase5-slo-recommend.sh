#!/bin/bash
# Derive SLO recommendation baselines from Phase 5 metrics CSV
# Usage: ./scripts/phase5-slo-recommend.sh results/phase5-*/metrics.csv

set -e
FILE=${1:-results/phase5-*/metrics.csv}
TARGET_FILE=$(ls -1 $FILE 2>/dev/null | head -1 || true)
if [ -z "$TARGET_FILE" ]; then
  echo "Metrics file not found. Provide path to metrics.csv." >&2
  exit 1
fi

echo "Using metrics file: $TARGET_FILE" >&2

awk -F',' 'NR>1 {
  success=$2*100;
  p50=$3; p95=$4; p99=$5;
  fb=$6*100; err=$7*100; cpu=$8; mem=$9; rate=$10;
  # aggregates
  c++;
  sum_success+=success; sum_p50+=p50; sum_p95+=p95; sum_p99+=p99;
  sum_fb+=fb; sum_err+=err; sum_cpu+=cpu; sum_mem+=mem; sum_rate+=rate;
} END {
  if(c==0){print "No data"; exit 1}
  avg_success=sum_success/c; avg_p50=sum_p50/c; avg_p95=sum_p95/c; avg_p99=sum_p99/c;
  avg_fb=sum_fb/c; avg_err=sum_err/c; avg_cpu=sum_cpu/c; avg_mem=sum_mem/c; avg_rate=sum_rate/c;
  # Recommended SLOs (heuristics with safety margins)
  # Success: target slightly below observed (allow 1% headroom)
  slo_success= (avg_success - 1 < 98 ? 98 : avg_success - 1);
  # Latency: target p99 upper bound 2x observed (floor to 0.5s min) capped at 2s
  slo_p99 = (avg_p99*2 < 0.5 ? 0.5 : (avg_p99*2 > 2 ? 2 : avg_p99*2));
  # Fallback: target 2x observed but not above 10%
  slo_fb = (avg_fb*2 > 10 ? 10 : avg_fb*2);
  # Error rate: keep <2% (if observed 0, set 1%)
  slo_err = (avg_err==0 ? 1 : (avg_err*2 > 2 ? 2 : avg_err*2));
  # CPU & Memory thresholds (add 30% headroom, cap 70/80)
  slo_cpu = (avg_cpu+30 > 70 ? 70 : avg_cpu+30);
  slo_mem = (avg_mem+30 > 80 ? 80 : avg_mem+30);

  printf "# Phase 5 SLO Recommendation (Derived)\n";
  printf "Source File: %s\n\n", ARGV[1];
  printf "## Observed Averages\n";
  printf "- Success Rate Avg: %.2f%%\n", avg_success;
  printf "- Latency Avg P50/P95/P99: %.3fs / %.3fs / %.3fs\n", avg_p50, avg_p95, avg_p99;
  printf "- Fallback Avg: %.2f%%\n", avg_fb;
  printf "- Error Rate Avg: %.2f%%\n", avg_err;
  printf "- CPU Avg: %.2f%%\n", avg_cpu;
  printf "- Memory Avg: %.2f%%\n", avg_mem;
  printf "- Request Rate Avg: %.4f req/s\n\n", avg_rate;
  printf "## Recommended Draft SLO Targets\n";
  printf "| Metric | Target | Rationale |\n";
  printf "|--------|--------|-----------|\n";
  printf "| HTTP Success Rate | %.2f%% | Observed %.2f%% minus ~1%% headroom |\n", slo_success, avg_success;
  printf "| P99 Latency | %.3fs | 2x observed (cap 2s) |\n", slo_p99;
  printf "| Fallback Ratio | < %.2f%% | 2x observed capped at 10%% |\n", slo_fb;
  printf "| 5xx Error Rate | < %.2f%% | Double observed (cap 2%%, floor 1%%) |\n", slo_err;
  printf "| CPU Utilization | < %.2f%% | Observed +30%% headroom (cap 70%%) |\n", slo_cpu;
  printf "| Memory Utilization | < %.2f%% | Observed +30%% headroom (cap 80%%) |\n", slo_mem;
  printf "\n## Notes\n";
  printf "- Replace placeholders after production rerun.\n";
  printf "- Adjust latency targets if variance >30%% in 24h window.\n";
  printf "- Consider error budget: (100 - target success rate)%% monthly.\n";
}' "$TARGET_FILE" > /dev/stdout

