#!/usr/bin/env bash
set -euo pipefail

# Build a Slack summary message for Phase 5 nightly validation.
# Usage: scripts/phase5-build-slack-summary.sh <current.json> <baseline.json> <suggestions.json> [cache_audit.txt]
# Outputs formatted plaintext to stdout suitable for wrapping with jq -Rs '{text:.}'.
# Requires: jq

CUR_JSON="${1:-}"; BASE_JSON="${2:-}"; SUG_JSON="${3:-}"; AUDIT_TXT="${4:-}";

command -v jq >/dev/null 2>&1 || { echo "jq required" >&2; exit 2; }

[[ -f "$CUR_JSON" ]] || { echo "Current JSON not found: $CUR_JSON" >&2; exit 2; }
[[ -f "$BASE_JSON" ]] || { echo "Baseline JSON not found: $BASE_JSON" >&2; exit 2; }
if [[ ! -f "$SUG_JSON" ]]; then
  echo "Suggestions JSON not found: $SUG_JSON" >&2
  SUG_JSON=""
fi

val() { jq -r "$2 // empty" "$1"; }

passed=$(val "$CUR_JSON" '.summary.passed')
failed=$(val "$CUR_JSON" '.summary.failed')
na=$(val "$CUR_JSON" '.summary.na')
status=$(val "$CUR_JSON" '.summary.overall_status')
gen_at=$(val "$CUR_JSON" '.generated_at // .timestamp')

http_succ=$(val "$CUR_JSON" '.counters.http_success_rate')
cache_hit=$(val "$CUR_JSON" '.counters.cache_hit_rate')
fallback_eff=$(val "$CUR_JSON" '.counters.fallback_effective_ratio')
mem_mb=$(val "$CUR_JSON" '.counters.memory_rss_mb')

snap_create_p95=$(val "$CUR_JSON" '.percentiles["metasheet_snapshot_operation_duration_seconds{operation=\"create\"}"].p95')
snap_restore_p95=$(val "$CUR_JSON" '.percentiles["metasheet_snapshot_operation_duration_seconds{operation=\"restore\"}"].p95')
plugin_p95=$(val "$CUR_JSON" '.percentiles["metasheet_plugin_reload_duration_seconds{plugin_name=\"example-plugin\"}"].p95')

redis_get_p95=$(val "$CUR_JSON" '.percentiles["redis_operation_duration_seconds{op=\"get\"}"].p95')
redis_set_p95=$(val "$CUR_JSON" '.percentiles["redis_operation_duration_seconds{op=\"set\"}"].p95')
redis_recent_fail=$(val "$CUR_JSON" '.counters.redis_recent_failures')

# Fallback top reasons (5m increase heuristic if metrics endpoint provided via METRICS_URL)
fallback_top=""
if [[ -n "${METRICS_URL:-}" ]]; then
  if curl -sSf -m 3 "$METRICS_URL" >/dev/null 2>&1; then
    # Preferred: use recording rule metasheet:fallback_reason_rate:5m if present
    tmp_fb=$(mktemp)
    curl -s "$METRICS_URL" | grep '^metasheet_fallback_total' > /dev/null || true
    # Try direct PromQL via curl if server supports query endpoint (optional)
    fb_query=$(curl -sG --data-urlencode 'query=metasheet:fallback_reason_rate:5m' "${METRICS_URL%/metrics/*}/api/v1/query" 2>/dev/null || true)
    if echo "$fb_query" | grep -q '"status":"success"'; then
      fallback_top=$(echo "$fb_query" | jq -r '.data.result[] | "\(.metric.reason)(\(.value[1]))"' | sort -t '(' -k2 -nr | head -n3 | tr '\n' ' ')
    fi
    rm -f "$tmp_fb"
  fi
fi

# Error budget remaining (assuming 99% target)
http_target=99
error_budget_remaining=""
if [[ -n "$http_succ" ]]; then
  # If success >= target: compute remaining percentage of budget used (inverse)
  eb_used=$(awk -v cur="$http_succ" -v tgt="$http_target" 'BEGIN{d=(tgt-cur); if (d<0) d=0; used=d/(100-tgt); rem=1-used; printf("%.0f", rem*100)}')
  error_budget_remaining="$eb_used%"
fi

# Baseline values for deltas
base_http_succ=$(val "$BASE_JSON" '.counters.http_success_rate')
base_cache_hit=$(val "$BASE_JSON" '.counters.cache_hit_rate')
base_snap_restore_p95=$(val "$BASE_JSON" '.percentiles["metasheet_snapshot_operation_duration_seconds{operation=\"restore\"}"].p95')
base_snap_create_p95=$(val "$BASE_JSON" '.percentiles["metasheet_snapshot_operation_duration_seconds{operation=\"create\"}"].p95')
base_plugin_p95=$(val "$BASE_JSON" '.percentiles["metasheet_plugin_reload_duration_seconds{plugin_name=\"example-plugin\"}"].p95')
base_redis_get_p95=$(val "$BASE_JSON" '.percentiles["redis_operation_duration_seconds{op=\"get\"}"].p95')
base_redis_set_p95=$(val "$BASE_JSON" '.percentiles["redis_operation_duration_seconds{op=\"set\"}"].p95')

delta_pct() { # percentage point difference
  local a="$1" b="$2"; if [[ -z "$a" || -z "$b" ]]; then echo ""; return; fi; awk -v cur="$a" -v base="$b" 'BEGIN{printf("%.2f", cur-base)}'; }
delta_ms() { local a="$1" b="$2"; if [[ -z "$a" || -z "$b" ]]; then echo ""; return; fi; awk -v cur="$a" -v base="$b" 'BEGIN{printf("%.0f", (cur-base)*1000)}'; }

http_succ_delta=$(delta_pct "$http_succ" "$base_http_succ")
cache_hit_delta=$(delta_pct "$cache_hit" "$base_cache_hit")
snap_restore_p95_delta_ms=$(delta_ms "$snap_restore_p95" "$base_snap_restore_p95")
snap_create_p95_delta_ms=$(delta_ms "$snap_create_p95" "$base_snap_create_p95")
plugin_p95_delta_ms=$(delta_ms "$plugin_p95" "$base_plugin_p95")
redis_get_p95_delta_ms=$(delta_ms "$redis_get_p95" "$base_redis_get_p95")
redis_set_p95_delta_ms=$(delta_ms "$redis_set_p95" "$base_redis_set_p95")

suggestions_block=""
if [[ -n "$SUG_JSON" ]]; then
  if [[ -f "$SUG_JSON" ]]; then
    count=$(jq '.suggestions | length' "$SUG_JSON")
    if [[ "$count" -gt 0 ]]; then
      suggestions_block="Suggestions (tighten candidates):\n"
      shown=0
      while IFS= read -r line; do
        ((shown++))
        if (( shown <= 5 )); then
          suggestions_block+=" - $(echo "$line" | jq -r '.metric'): current=$(echo "$line" | jq -r '.current_threshold') median=$(echo "$line" | jq -r '.median_observed') proposed=$(echo "$line" | jq -r '.suggested_threshold')\n"
        fi
      done < <(jq -c '.suggestions[]' "$SUG_JSON")
      if (( count > 5 )); then
        suggestions_block+=" (+$((count-5)) more)\n"
      fi
    fi
  fi
fi

audit_block=""
if [[ -n "$AUDIT_TXT" && -f "$AUDIT_TXT" ]]; then
  audit_block="Cache Audit (low-hit patterns):\n$(head -n 20 "$AUDIT_TXT")\n"
fi

norm_status=$(echo "$status" | tr '[:lower:]' '[:upper:]')
status_emoji=":white_check_mark:"
[[ "$norm_status" != "PASS" ]] && status_emoji=":warning:"

norm() { local v="$1"; [[ -z "$v" || "$v" == "null" ]] && echo "—" || printf "%s" "$v"; }
fmt_ms() { local v="$1"; [[ -z "$v" || "$v" == "null" ]] && echo "—" || awk -v x="$v" 'BEGIN{printf("%d", x)}'; }

# Risk pointer logic
risk_points=()
if [[ -n "$http_succ" && -n "$base_http_succ" ]]; then
  # Error budget usage approximation: if success rate dropped more than 0.3pp from baseline
  eb_drop=$(awk -v cur="$http_succ" -v base="$base_http_succ" 'BEGIN{d=base-cur; if (d>0.3) print 1; else print 0}')
  if [[ "$eb_drop" == "1" ]]; then risk_points+=("HTTP success ▼") ; fi
fi
if [[ -n "$cache_hit" && $(awk -v c="$cache_hit" 'BEGIN{print (c < 80)?1:0}') == 1 ]]; then risk_points+=("Cache hit <80%") ; fi
if [[ -n "$fallback_eff" && $(awk -v f="$fallback_eff" 'BEGIN{print (f > 5)?1:0}') == 1 ]]; then risk_points+=("Fallback >5%") ; fi
if [[ -n "$redis_recent_fail" && "$redis_recent_fail" != "0" ]]; then risk_points+=("Redis failures recent") ; fi
if [[ -n "$redis_get_p95" && $(awk -v v="$redis_get_p95" 'BEGIN{print (v > 0.05)?1:0}') == 1 ]]; then risk_points+=("Redis GET p95>50ms") ; fi
if [[ -n "$redis_set_p95" && $(awk -v v="$redis_set_p95" 'BEGIN{print (v > 0.05)?1:0}') == 1 ]]; then risk_points+=("Redis SET p95>50ms") ; fi

risk_line=""
if (( ${#risk_points[@]} > 0 )); then
  risk_line="Risks: ${risk_points[*]}"
fi

cat <<EOF
${status_emoji} Phase 5 SLO Validation ${norm_status} (${passed}/${passed}+${failed}+${na}) @ ${gen_at}
HTTP Success: $(norm "$http_succ")% (Δ $(norm "$http_succ_delta")pp) | Cache Hit: $(norm "$cache_hit")% (Δ $(norm "$cache_hit_delta")pp)
Fallback Effective: $(norm "$fallback_eff")% | Memory RSS: $(norm "$mem_mb")MB
Snapshot p95 create=$(norm "$snap_create_p95")s (Δ $(fmt_ms "$snap_create_p95_delta_ms")ms) restore=$(norm "$snap_restore_p95")s (Δ $(fmt_ms "$snap_restore_p95_delta_ms")ms)
Plugin p95=$(norm "$plugin_p95")s (Δ $(fmt_ms "$plugin_p95_delta_ms")ms)
Redis p95 get=$(norm "$redis_get_p95")s (Δ $(fmt_ms "$redis_get_p95_delta_ms")ms) set=$(norm "$redis_set_p95")s (Δ $(fmt_ms "$redis_set_p95_delta_ms")ms) recent_fail=$(norm "$redis_recent_fail")
Redis baseline get=$(norm "$base_redis_get_p95")s set=$(norm "$base_redis_set_p95")s

${suggestions_block}${audit_block}${risk_line}
Error Budget Remaining: $(norm "$error_budget_remaining")
Fallback Top: $(norm "$fallback_top")
Baseline file: $(basename "$BASE_JSON")
EOF
