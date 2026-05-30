#!/usr/bin/env bash
set -euo pipefail

RAW_FILE="${1:-}"

if [ -z "$RAW_FILE" ] || [ ! -f "$RAW_FILE" ]; then
  echo "Usage: $0 <prometheus-raw-metrics-file>" >&2
  exit 2
fi

sum_metric() {
  local metric_name="$1"

  awk -v metric="$metric_name" '
    $0 !~ /^#/ && ($1 == metric || index($1, metric "{") == 1) {
      sum += $2
    }
    END { printf "%.0f", sum + 0 }
  ' "$RAW_FILE"
}

emit_result() {
  local source="$1"
  local hits="$2"
  local misses="$3"
  local total=$((hits + misses))
  local hit_rate="0"

  if [ "$total" -gt 0 ]; then
    hit_rate=$(awk -v h="$hits" -v t="$total" 'BEGIN { printf "%.2f", (h * 100) / t }')
  fi

  jq -n \
    --arg source "$source" \
    --argjson hits "$hits" \
    --argjson misses "$misses" \
    --argjson total "$total" \
    --argjson hit_rate "$hit_rate" \
    '{
      source: $source,
      hits: $hits,
      misses: $misses,
      total: $total,
      hit_rate: $hit_rate
    }'
}

generic_hits=$(sum_metric cache_hits_total)
generic_misses=$(sum_metric cache_miss_total)
generic_total=$((generic_hits + generic_misses))

if [ "$generic_total" -gt 0 ]; then
  emit_result generic_cache "$generic_hits" "$generic_misses"
  exit 0
fi

rbac_hits=$(sum_metric rbac_perm_cache_hits_total)
rbac_misses=$(sum_metric rbac_perm_cache_miss_total)
rbac_total=$((rbac_hits + rbac_misses))
legacy_rbac_misses=$(sum_metric rbac_perm_cache_misses_total)
legacy_rbac_total=$((rbac_hits + legacy_rbac_misses))

if [ "$rbac_misses" -eq 0 ] && [ "$legacy_rbac_total" -gt 0 ]; then
  emit_result rbac_permission_cache_legacy "$rbac_hits" "$legacy_rbac_misses"
  exit 0
fi

if [ "$rbac_total" -gt 0 ]; then
  emit_result rbac_permission_cache "$rbac_hits" "$rbac_misses"
  exit 0
fi

emit_result none 0 0
