#!/bin/bash
# Phase 5: Fill production baseline report from metrics CSV (v3 schema)
set -euo pipefail

FILE=${1:-}
if [ -z "$FILE" ] || [ ! -f "$FILE" ]; then
  echo "Metrics CSV not found: $FILE" >&2
  exit 1
fi

# SLO targets (defaults; override via env)
SLO_SUCCESS=${SLO_SUCCESS:-98}
SLO_P95=${SLO_P95:-0.150}
SLO_P99=${SLO_P99:-0.250}
SLO_FALLBACK=${SLO_FALLBACK:-10}
SLO_EFF_FALLBACK=${SLO_EFF_FALLBACK:-${EFFECTIVE_FALLBACK_SLO_TARGET:-5}}
SLO_ERROR=${SLO_ERROR:-1}
SLO_CPU=${SLO_CPU:-30}
SLO_MEM=${SLO_MEM:-500}
SLO_CACHE_HIT=${SLO_CACHE_HIT:-80}
SLO_PLUGIN_RELOAD=${SLO_PLUGIN_RELOAD:-95}
SLO_SNAPSHOT=${SLO_SNAPSHOT:-99}

awk -F',' -v slo_success="$SLO_SUCCESS" -v slo_p95="$SLO_P95" -v slo_p99="$SLO_P99" -v slo_fb="$SLO_FALLBACK" -v slo_eff_fb="$SLO_EFF_FALLBACK" -v slo_err="$SLO_ERROR" -v slo_cpu="$SLO_CPU" -v slo_mem="$SLO_MEM" -v slo_cache_hit="$SLO_CACHE_HIT" -v slo_plugin_reload="$SLO_PLUGIN_RELOAD" -v slo_snapshot="$SLO_SNAPSHOT" 'NR==1 {next} {
  # CSV v3 header mapping (includes sample_num)
  ts=$1; success=$2*100; p50=$3; p90=$4; p95=$5; p99=$6; raw_fb=$7*100; eff_fb_ratio=$8*100; err=$9*100; err4=$10*100; err5=$11*100; cpu=$12; rss=$13; rate=$14; raw_fb_total=$15; eff_fb_total=$16; fb_http=$17; fb_msg=$18; fb_cache=$19; http_ops=$20; rpc_attempts=$21; cache_attempts=$22; fb_http_ratio=$23*100; fb_msg_ratio=$24*100; fb_cache_ratio=$25*100; pr_ok=$26; pr_fail=$27; sc_ok=$28; sc_fail=$29; sr_ok=$30; sr_fail=$31; cache_hit=$32; plugin_p95=$33; plugin_p99=$34; plugin_success_rate=$35*100; snap_p95=$36; snap_p99=$37; snapshot_success_rate=$38*100; cache_hits_raw=$39; cache_misses_raw=$40; sample_num=$41;
  if (count==0) {min_success=max_success=success; min_p50=max_p50=p50; min_p90=max_p90=p90; min_p95=max_p95=p95; min_p99=max_p99=p99; min_raw_fb=max_raw_fb=raw_fb; min_eff_fb=max_eff_fb=eff_fb_ratio; min_err=max_err=err; min_cpu=max_cpu=cpu; min_rss=max_rss=rss; min_rate=max_rate=rate}
  if (success<min_success) min_success=success; if (success>max_success) max_success=success; sum_success+=success;
  if (p50<min_p50) min_p50=p50; if (p50>max_p50) max_p50=p50; sum_p50+=p50;
  if (p90<min_p90) min_p90=p90; if (p90>max_p90) max_p90=p90; sum_p90+=p90;
  if (p95<min_p95) min_p95=p95; if (p95>max_p95) max_p95=p95; sum_p95+=p95;
  if (p99<min_p99) min_p99=p99; if (p99>max_p99) max_p99=p99; sum_p99+=p99;
  if (raw_fb<min_raw_fb) min_raw_fb=raw_fb; if (raw_fb>max_raw_fb) max_raw_fb=raw_fb; sum_raw_fb+=raw_fb;
  if (eff_fb_ratio<min_eff_fb) min_eff_fb=eff_fb_ratio; if (eff_fb_ratio>max_eff_fb) max_eff_fb=eff_fb_ratio; sum_eff_fb+=eff_fb_ratio;
  if (err<min_err) min_err=err; if (err>max_err) max_err=err; sum_err+=err;
  if (cpu<min_cpu) min_cpu=cpu; if (cpu>max_cpu) max_cpu=cpu; sum_cpu+=cpu;
  if (rss<min_rss) min_rss=rss; if (rss>max_rss) max_rss=rss; sum_rss+=rss;
  if (rate<min_rate) min_rate=rate; if (rate>max_rate) max_rate=rate; sum_rate+=rate;
  sum_fb_http+=fb_http; sum_fb_msg+=fb_msg; sum_fb_cache+=fb_cache; sum_http_ops+=http_ops; sum_rpc_attempts+=rpc_attempts; sum_cache_attempts+=cache_attempts;
  sum_fb_http_ratio+=fb_http_ratio; sum_fb_msg_ratio+=fb_msg_ratio; sum_fb_cache_ratio+=fb_cache_ratio;
  sum_err4+=err4; sum_err5+=err5; sum_pr_ok+=pr_ok; sum_pr_fail+=pr_fail; sum_sc_ok+=sc_ok; sum_sc_fail+=sc_fail; sum_sr_ok+=sr_ok; sum_sr_fail+=sr_fail;
  arr_success[NR]=success; arr_p99[NR]=p99; arr_raw_fb[NR]=raw_fb; arr_eff_fb[NR]=eff_fb_ratio; arr_err[NR]=err;
  count++;
} END {
  if (count==0){print "No samples"; exit 1}
  avg_success=sum_success/count; avg_p50=sum_p50/count; avg_p90=sum_p90/count; avg_p95=sum_p95/count; avg_p99=sum_p99/count; avg_raw_fb=sum_raw_fb/count; avg_eff_fb=sum_eff_fb/count; avg_err=sum_err/count; avg_cpu=sum_cpu/count; avg_rss=sum_rss/count; avg_rate=sum_rate/count;
  verdict_success=(avg_success >= slo_success ? "Pass" : "Fail");
  verdict_p95=(avg_p95 <= slo_p95 ? "Pass" : "Fail");
  verdict_p99=(avg_p99 <= slo_p99 ? "Pass" : "Fail");
  verdict_raw_fb=(avg_raw_fb <= slo_fb ? "Pass" : "Fail");
  verdict_eff_fb=(avg_eff_fb <= slo_eff_fb ? "Pass" : "Fail");
  verdict_err=(avg_err <= slo_err ? "Pass" : "Fail");
  verdict_cpu=(avg_cpu <= slo_cpu ? "Pass" : "Fail");
  verdict_mem=(avg_rss <= slo_mem ? "Pass" : "Fail");
  # Aggregate-wide success metrics accumulation across samples
  # Cache hit rate: we only have per-sample percentage; compute average of available samples
  if (cache_hit != "NA") { sum_cache_hit_pct+=cache_hit*100; samples_cache_hit++ }
  total_plugin_ops+=(pr_ok+pr_fail); total_plugin_success+=pr_ok;
  total_snapshot_ops+=(sc_ok+sc_fail+sr_ok+sr_fail); total_snapshot_success+=(sc_ok+sr_ok);
  total_cache_hits+=cache_hits_raw; total_cache_misses+=cache_misses_raw;
  avg_cache_hit_sample=(samples_cache_hit>0 ? (sum_cache_hit_pct/samples_cache_hit) : "NA");
  avg_cache_hit_global=((total_cache_hits+total_cache_misses)>0 ? (100*total_cache_hits/(total_cache_hits+total_cache_misses)) : avg_cache_hit_sample);
  avg_plugin_success=(total_plugin_ops>0 ? (100*total_plugin_success/total_plugin_ops) : "NA");
  avg_snapshot_success=(total_snapshot_ops>0 ? (100*total_snapshot_success/total_snapshot_ops) : "NA");
  verdict_cache_hit=(avg_cache_hit_global!="NA" && avg_cache_hit_global >= slo_cache_hit ? "Pass" : (avg_cache_hit_global=="NA"?"NA":"Fail"));
  verdict_plugin_success=(avg_plugin_success!="NA" && avg_plugin_success >= slo_plugin_reload ? "Pass" : (avg_plugin_success=="NA"?"NA":"Fail"));
  verdict_snapshot_success=(avg_snapshot_success!="NA" && avg_snapshot_success >= slo_snapshot ? "Pass" : (avg_snapshot_success=="NA"?"NA":"Fail"));
  go=(verdict_success=="Pass" && verdict_p95=="Pass" && verdict_p99=="Pass" && verdict_raw_fb=="Pass" && verdict_eff_fb=="Pass" && verdict_err=="Pass" && verdict_cpu=="Pass" && verdict_mem=="Pass" && verdict_cache_hit!="Fail" && verdict_plugin_success!="Fail" && verdict_snapshot_success!="Fail" ? "Go" : "No-Go");

  for (i in arr_success) { d=arr_success[i]-avg_success; ss_success+=d*d }
  for (i in arr_p99) { d=arr_p99[i]-avg_p99; ss_p99+=d*d }
  for (i in arr_raw_fb) { d=arr_raw_fb[i]-avg_raw_fb; ss_raw_fb+=d*d }
  for (i in arr_eff_fb) { d=arr_eff_fb[i]-avg_eff_fb; ss_eff_fb+=d*d }
  for (i in arr_err) { d=arr_err[i]-avg_err; ss_err+=d*d }
  std_success=(count>1?sqrt(ss_success/count):0)
  std_p99=(count>1?sqrt(ss_p99/count):0)
  std_raw_fb=(count>1?sqrt(ss_raw_fb/count):0)
  std_eff_fb=(count>1?sqrt(ss_eff_fb/count):0)
  std_err=(count>1?sqrt(ss_err/count):0)

  print "# Phase 5 Production Baseline Report";
  # macOS / BSD awk may not have strftime; fallback to external date
  # Portable UTC timestamp
  cmd="date -u +%Y-%m-%dT%H:%M:%SZ"
  cmd | getline gen_ts
  close(cmd)
  print "Generated: " gen_ts;
  print "Samples: " count;
  print "Overall Verdict: " go;
  print "\n## SLO Summary";
  printf "| Metric | Min | Max | Avg | StdDev | Target | Verdict |\n";
  printf "|--------|-----|-----|-----|--------|--------|---------|\n";
  printf "| Success Rate %% | %.2f | %.2f | %.2f | %.2f | >= %.0f%% | %s |\n", min_success, max_success, avg_success, std_success, slo_success, verdict_success;
  printf "| P95 Latency (s) | %.3f | %.3f | %.3f | - | <= %.3fs | %s |\n", min_p95, max_p95, avg_p95, slo_p95, verdict_p95;
  printf "| P99 Latency (s) | %.3f | %.3f | %.3f | %.3f | <= %.3fs | %s |\n", min_p99, max_p99, avg_p99, std_p99, slo_p99, verdict_p99;
  printf "| Raw Fallback %% | %.4f | %.4f | %.4f | %.4f | < %.2f%% | %s |\n", min_raw_fb, max_raw_fb, avg_raw_fb, std_raw_fb, slo_fb, verdict_raw_fb;
  printf "| Effective Fallback %% | %.4f | %.4f | %.4f | %.4f | < %.2f%% | %s |\n", min_eff_fb, max_eff_fb, avg_eff_fb, std_eff_fb, slo_eff_fb, verdict_eff_fb;
  printf "| Error Rate %% | %.4f | %.4f | %.4f | %.4f | < %.2f%% | %s |\n", min_err, max_err, avg_err, std_err, slo_err, verdict_err;
  printf "| CPU %% | %.2f | %.2f | %.2f | - | < %.0f%% | %s |\n", min_cpu, max_cpu, avg_cpu, slo_cpu, verdict_cpu;
  printf "| RSS Memory (MB) | %.2f | %.2f | %.2f | - | < %.0fMB | %s |\n", min_rss, max_rss, avg_rss, slo_mem, verdict_mem;
  printf "| Cache Hit Rate Global %% | - | - | %s | - | >= %.0f%% | %s |\n", (avg_cache_hit_global=="NA"?"NA":sprintf("%.2f", avg_cache_hit_global)), slo_cache_hit, verdict_cache_hit;
  if (avg_cache_hit_sample != "NA" && avg_cache_hit_global != "NA") printf "| Cache Hit Rate Sample Avg %% | - | - | %.2f | - | (info) | NA |\n", avg_cache_hit_sample;
  printf "| Plugin Reload Success %% | - | - | %s | - | >= %.0f%% | %s |\n", (avg_plugin_success=="NA"?"NA":sprintf("%.2f", avg_plugin_success)), slo_plugin_reload, verdict_plugin_success;
  printf "| Snapshot Success %% | - | - | %s | - | >= %.0f%% | %s |\n", (avg_snapshot_success=="NA"?"NA":sprintf("%.2f", avg_snapshot_success)), slo_snapshot, verdict_snapshot_success;

  print "\n## Throughput";
  printf "Average Request Rate: %.3f req/s\n", avg_rate;
  printf "HTTP Ops Total: %.0f  RPC Attempts: %.0f  Cache Attempts: %.0f\n", sum_http_ops, sum_rpc_attempts, sum_cache_attempts;

  print "\n## Fallback Sources";
  printf "HTTP Fallback Ratio Avg: %.4f%%\n", (sum_fb_http_ratio/count);
  printf "MessageBus Fallback Ratio Avg: %.4f%%\n", (sum_fb_msg_ratio/count);
  printf "Cache Fallback Ratio Avg: %.4f%%\n", (sum_fb_cache_ratio/count);

  print "\n## Plugin Reload & Snapshot Operations";
  printf "Plugin Reload Success: %.0f Failure: %.0f\n", sum_pr_ok, sum_pr_fail;
  printf "Snapshot Create Success: %.0f Failure: %.0f\n", sum_sc_ok, sum_sc_fail;
  printf "Snapshot Restore Success: %.0f Failure: %.0f\n", sum_sr_ok, sum_sr_fail;

  print "\n## Targets";
  print "- Success Rate >= " slo_success "%";
  print "- P95 <= " slo_p95 "s";
  print "- P99 <= " slo_p99 "s";
  print "- Raw Fallback < " slo_fb "%";
  print "- Effective Fallback < " slo_eff_fb "%";
  print "- Error Rate < " slo_err "%";
  print "- CPU < " slo_cpu "%";
  print "- RSS Memory < " slo_mem "MB";
  print "- Cache Hit Rate >= " slo_cache_hit "%";
  print "- Plugin Reload Success >= " slo_plugin_reload "%";
  print "- Snapshot Success >= " slo_snapshot "%";

  print "\n## Next Actions";
  print "- Append to PHASE5_COMPLETION_REPORT.md (Production Section)";
  print "- Archive metrics and report under final-artifacts";
  print "- Review fallback source proportions";
}' "$FILE"
