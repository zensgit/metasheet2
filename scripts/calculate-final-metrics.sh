#!/bin/bash
# Calculate final metrics from observability CSV

export LC_ALL=C

awk -F',' '
NR>1 && $11!="COLD_START" && $11!="CRIT" && index($12,"collect_empty_source")==0 {
  s+=$9; f+=$10; c+=$5; p+=$7; n++
  if(NR==2 || $9<min_s) min_s=$9
  if(NR==2 || $10>max_f) max_f=$10
  if(NR==2 || $7>max_p) max_p=$7
}
END{
  printf "valid_samples=%d\n", n
  printf "mean_success_rate=%.4f\n", (n>0?s/n:0)
  printf "min_success_rate=%.4f\n", min_s
  printf "mean_fallback_ratio=%.4f\n", (n>0?f/n:0)
  printf "max_fallback_ratio=%.4f\n", max_f
  printf "mean_p99=%.3f\n", (n>0?p/n:0)
  printf "max_p99=%.3f\n", max_p
  printf "total_conflicts=%d\n", c
}' artifacts/observability-24h.csv
