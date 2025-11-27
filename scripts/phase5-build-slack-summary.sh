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
fallback_eff=$(val "$CUR_JSON" '.counters.fallback_effective_rate')
mem_mb=$(val "$CUR_JSON" '.counters.memory_rss_mb')

snap_create_p95=$(val "$CUR_JSON" '.percentiles["metasheet_snapshot_operation_duration_seconds{operation=\"create\"}"].p95')
snap_restore_p95=$(val "$CUR_JSON" '.percentiles["metasheet_snapshot_operation_duration_seconds{operation=\"restore\"}"].p95')
plugin_p95=$(val "$CUR_JSON" '.percentiles["metasheet_plugin_reload_duration_seconds{plugin_name=\"example-plugin\"}"].p95')

redis_get_p95=$(val "$CUR_JSON" '.percentiles["redis_operation_duration_seconds{op=\"get\"}"].p95')
redis_set_p95=$(val "$CUR_JSON" '.percentiles["redis_operation_duration_seconds{op=\"set\"}"].p95')
redis_recent_fail=$(val "$CUR_JSON" '.counters.redis_recent_failures')

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
      while IFS= read -r line; do
        suggestions_block+=" - $(echo "$line" | jq -r '.metric'): current=$(echo "$line" | jq -r '.current_threshold') median=$(echo "$line" | jq -r '.median_observed') proposed=$(echo "$line" | jq -r '.suggested_threshold')\n"
      done < <(jq -c '.suggestions[]' "$SUG_JSON")
    fi
  fi
fi

audit_block=""
if [[ -n "$AUDIT_TXT" && -f "$AUDIT_TXT" ]]; then
  audit_block="Cache Audit (low-hit patterns):\n$(head -n 20 "$AUDIT_TXT")\n"
fi

status_emoji=":white_check_mark:"
[[ "$status" != "PASS" ]] && status_emoji=":warning:"

cat <<EOF
${status_emoji} Phase 5 SLO Validation ${status} (${passed}/${passed}+${failed}+${na}) @ ${gen_at}
HTTP Success: ${http_succ}% (Δ ${http_succ_delta}pp) | Cache Hit: ${cache_hit}% (Δ ${cache_hit_delta}pp)
Fallback Effective: ${fallback_eff}% | Memory RSS: ${mem_mb}MB
Snapshot p95 create=${snap_create_p95}s (Δ ${snap_create_p95_delta_ms}ms) restore=${snap_restore_p95}s (Δ ${snap_restore_p95_delta_ms}ms)
Plugin p95=${plugin_p95}s (Δ ${plugin_p95_delta_ms}ms)
Redis p95 get=${redis_get_p95}s (Δ ${redis_get_p95_delta_ms}ms) set=${redis_set_p95}s (Δ ${redis_set_p95_delta_ms}ms) recent_fail=${redis_recent_fail}

${suggestions_block}${audit_block}Baseline file: $(basename "$BASE_JSON")
EOF

