#!/usr/bin/env bash
set -euo pipefail

PROM_URL=${PROM_URL:-}
AUTH=${PROM_AUTH:-} # e.g., user:pass or Bearer <token>
OUT="docs/sprint2/evidence/promql-summary.json"

if [[ -z "$PROM_URL" ]]; then
  echo "Usage: PROM_URL=... [PROM_AUTH=...] $0" >&2; exit 1
fi

q() {
  local query="$1"
  if [[ -n "$AUTH" ]]; then
    curl -sS -H "Authorization: $AUTH" --get --data-urlencode "query=$query" "$PROM_URL/api/v1/query"
  else
    curl -sS --get --data-urlencode "query=$query" "$PROM_URL/api/v1/query"
  fi
}

mkdir -p "$(dirname "$OUT")"

declare -A QUERIES=(
  [http_requests_total]='sum(increase(http_requests_total[5m]))'
  [snapshot_ops]='sum(increase(snapshot_operation_total[5m]))'
  [protection_evals]='sum(increase(protection_rule_evaluations_total[5m]))'
  [blocked_ops]='sum(increase(protection_rule_blocks_total[5m]))'
  [auth_fail]='sum(increase(auth_failures_total[5m]))'
  [rbac_denials]='sum(increase(rbac_denials_total[5m]))'
)

echo '{' > "$OUT"
first=1
for k in "${!QUERIES[@]}"; do
  res=$(q "${QUERIES[$k]}")
  val=$(echo "$res" | jq -r '.data.result[0].value[1] // 0' 2>/dev/null || echo 0)
  if [[ $first -eq 1 ]]; then first=0; else echo ',' >> "$OUT"; fi
  echo "\"$k\": $val" >> "$OUT"
done
echo '}' >> "$OUT"

echo "PromQL smoke summary -> $OUT"

