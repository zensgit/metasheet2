#!/usr/bin/env bash
set -euo pipefail

API_TOKEN=${API_TOKEN:-${1:-}}
BASE_URL=${BASE_URL:-${2:-http://localhost:8900}}
OUT="docs/sprint2/preflight-$(date +%Y%m%d_%H%M%S).log"

if [[ -z "$API_TOKEN" ]]; then
  echo "Usage: API_TOKEN=<token> $0 [BASE_URL]" >&2
  exit 1
fi

pass=0; fail=0
log() { echo -e "\n== $* ==" | tee -a "$OUT"; }
ok() { echo "[PASS] $*" | tee -a "$OUT"; pass=$((pass+1)); }
bad() { echo "[FAIL] $*" | tee -a "$OUT"; fail=$((fail+1)); }
auth() { curl -sS -H "Authorization: Bearer $API_TOKEN" -H 'x-user-id: preflight' -H 'Content-Type: application/json' "$@"; }

log "Health"
health=$(curl -sS "$BASE_URL/health" || true)
echo "$health" >> "$OUT"
echo "$health" | grep -q '"status":"ok"' && ok "Health ok" || bad "Health not ok"

log "Create snapshot baseline"
snap_res=$(auth -X POST "$BASE_URL/api/snapshots" --data '{"view_id":"v-demo","name":"preflight","description":"pf","snapshot_type":"manual","metadata":{}}' || true)
echo "$snap_res" >> "$OUT"
SNAP_ID=$(echo "$snap_res" | jq -r '.data.id // empty')
[[ -n "$SNAP_ID" ]] && ok "Snapshot created ($SNAP_ID)" || bad "Snapshot create failed"

log "Snapshot stats"
stats_res=$(auth "$BASE_URL/api/snapshots/stats" || true)
echo "$stats_res" >> "$OUT"
echo "$stats_res" | jq -e '.ok==true' >/dev/null 2>&1 && ok "Stats accessible" || bad "Stats failed"

log "Protection rule quick test"
RULE_NAME="pf-rule-$(date +%s)"
rule_res=$(auth -X POST "$BASE_URL/api/admin/safety/rules" --data '{"rule_name":"'$RULE_NAME'","description":"pf","target_type":"snapshot","conditions":{"all":[{"field":"protection_level","operator":"eq","value":"critical"}]},"effects":{"action":"block"},"priority":100,"is_active":true}' || true)
echo "$rule_res" >> "$OUT"
RULE_ID=$(echo "$rule_res" | jq -r '.rule.id // empty')
[[ -n "$RULE_ID" ]] && ok "Rule created" || bad "Rule create failed"

eval_res=$(auth -X POST "$BASE_URL/api/admin/safety/rules/evaluate" --data '{"entity_type":"snapshot","entity_id":"'$SNAP_ID'","operation":"restore","properties":{"protection_level":"critical"}}' || true)
echo "$eval_res" >> "$OUT"
echo "$eval_res" | jq -e '.result.matched==true' >/dev/null 2>&1 && ok "Rule matched" || bad "Rule eval failed"

log "Metrics scrape"
metrics_res=$(curl -sS "$BASE_URL/metrics" || true)
echo "$metrics_res" >> "$OUT"
for m in protection_rule_evaluations_total protection_rule_blocks_total jwt_auth_fail_total; do
  echo "$metrics_res" | grep -q "$m" && ok "Metric $m present" || bad "Metric $m missing"
done

log "Summary"
echo "Passes: $pass Fails: $fail" | tee -a "$OUT"
[[ $fail -eq 0 ]] || exit 1
echo "Preflight log: $OUT"
