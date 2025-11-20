#!/usr/bin/env bash
set -euo pipefail

# Simple assertion helpers
pass_count=0
fail_count=0
assert() { # usage: assert <condition> <message>
  if eval "$1"; then
    echo "[PASS] $2"
    pass_count=$((pass_count+1))
  else
    echo "[FAIL] $2" >&2
    fail_count=$((fail_count+1))
    fail=1
  fi
}

API_TOKEN=${1:-}
BASE_URL=${2:-http://localhost:8900}
EVIDENCE_DIR="docs/sprint2/evidence"
TS=$(date +%Y%m%d_%H%M%S)

if [[ -z "$API_TOKEN" ]]; then
  echo "Usage: $0 <API_TOKEN> [BASE_URL]" >&2
  exit 1
fi

mkdir -p "$EVIDENCE_DIR"

auth() { curl -sS -H "Authorization: Bearer $API_TOKEN" -H 'x-user-id: staging-validator' -H 'Content-Type: application/json' "$@"; }

log() { echo -e "\n=== $* ==="; }

fail=0

log "Create Snapshot"
create_status=$(curl -sS -o /tmp/snap.res -w '%{http_code}' -H "Authorization: Bearer $API_TOKEN" -H 'x-user-id: staging-validator' -H 'Content-Type: application/json' -X POST "$BASE_URL/api/snapshots" --data '{"view_id":"v-demo","name":"staging-validate","description":"sprint2","snapshot_type":"manual","metadata":{}}' || true)
SNAP_JSON=$(cat /tmp/snap.res)
echo "$SNAP_JSON" > "$EVIDENCE_DIR/snapshot-create-$TS.json"
assert "[ $create_status -eq 201 ]" "Snapshot create status 201"
if command -v jq >/dev/null 2>&1; then
  SNAP_ID=$(echo "$SNAP_JSON" | jq -r '.data.id // .data?.snapshot_id // empty')
  assert "[ \"$SNAP_ID\" != \"\" ]" "Snapshot ID extracted"
else
  SNAP_ID=$(python3 - << 'PY' "$SNAP_JSON"
import json,sys
try:
  d=json.loads(sys.argv[1]);
  v=(d.get('data') or {}).get('id') or (d.get('data') or {}).get('snapshot_id') or ''
  print(v)
except Exception:
  print('')
PY
  )
  [[ -n "$SNAP_ID" ]] && echo "[PASS] Snapshot ID extracted" || { echo "[FAIL] Snapshot ID missing"; fail=1; fail_count=$((fail_count+1)); }
fi

log "Get Snapshot"
get_status=$(auth -o /tmp/snap.get -w '%{http_code}' "$BASE_URL/api/snapshots/$SNAP_ID" || true)
cat /tmp/snap.get > "$EVIDENCE_DIR/snapshot-get-$TS.json"
assert "[ $get_status -eq 200 ]" "Get snapshot status 200"
if command -v jq >/dev/null 2>&1; then
  assert "[ \"$(jq -r '.data.id' /tmp/snap.get 2>/dev/null)\" = \"$SNAP_ID\" ]" "Snapshot ID matches"
fi

log "Set Tags"
tag_status=$(auth -X PUT "$BASE_URL/api/admin/snapshots/$SNAP_ID/tags" --data '{"add":["staging","sprint2"],"remove":[]}' -o /tmp/snap.tags -w '%{http_code}' || true)
cat /tmp/snap.tags > "$EVIDENCE_DIR/snapshot-tags-$TS.json"
assert "[ $tag_status -eq 200 ]" "Set tags status 200"
if command -v jq >/dev/null 2>&1; then
  assert "jq -e '.snapshot.tags | map(select(.==\"staging\")) | length > 0' /tmp/snap.tags >/dev/null" "Tag 'staging' present"
fi

log "Set Protection"
prot_status=$(auth -X PATCH "$BASE_URL/api/admin/snapshots/$SNAP_ID/protection" --data '{"level":"protected"}' -o /tmp/snap.prot -w '%{http_code}' || true)
cat /tmp/snap.prot > "$EVIDENCE_DIR/snapshot-protection-$TS.json"
assert "[ $prot_status -eq 200 ]" "Set protection status 200"
if command -v jq >/dev/null 2>&1; then
  assert "[ \"$(jq -r '.snapshot.protection_level' /tmp/snap.prot)\" = \"protected\" ]" "Protection level updated"
fi

log "Set Release Channel"
chan_status=$(auth -X PATCH "$BASE_URL/api/admin/snapshots/$SNAP_ID/release-channel" --data '{"channel":"canary"}' -o /tmp/snap.chan -w '%{http_code}' || true)
cat /tmp/snap.chan > "$EVIDENCE_DIR/snapshot-channel-$TS.json"
assert "[ $chan_status -eq 200 ]" "Set release channel status 200"
if command -v jq >/dev/null 2>&1; then
  assert "[ \"$(jq -r '.snapshot.release_channel' /tmp/snap.chan)\" = \"canary\" ]" "Release channel updated"
fi

log "Query by Tag (admin)"
query_status=$(auth -o /tmp/snap.qtag -w '%{http_code}' "$BASE_URL/api/admin/snapshots?tags=staging" || true)
cat /tmp/snap.qtag > "$EVIDENCE_DIR/snapshot-query-tag-$TS.json"
assert "[ $query_status -eq 200 ]" "Query by tag status 200"
if command -v jq >/dev/null 2>&1; then
  assert "jq -e '.snapshots | length > 0' /tmp/snap.qtag >/dev/null" "Query returned >=1 snapshots"
fi

log "Create Rule (block)"
RAND_SUFFIX=$(openssl rand -hex 4 2>/dev/null || echo $RANDOM)
RULE_NAME="block-critical-restore-$TS-$RAND_SUFFIX"
CREATE_RULE_PAYLOAD=$(cat <<JSON
{
  "rule_name":"$RULE_NAME",
  "description":"block restore for critical",
  "target_type":"snapshot",
  "conditions":{
    "all":[
      {"field":"protection_level","operator":"eq","value":"critical"},
      {"field":"operation","operator":"eq","value":"restore"}
    ]
  },
  "effects":{"action":"block"},
  "priority":100,
  "is_active":true
}
JSON
)
RULE_STATUS=$(echo "$CREATE_RULE_PAYLOAD" | auth -X POST "$BASE_URL/api/admin/safety/rules" --data @- -o /tmp/rule.create -w '%{http_code}' || true)
RULE_JSON=$(cat /tmp/rule.create)
echo "$RULE_JSON" > "$EVIDENCE_DIR/rule-create-$TS.json"
assert "[ $RULE_STATUS -eq 200 -o $RULE_STATUS -eq 201 ]" "Rule create status 200/201"
RULE_ID=$(echo "$RULE_JSON" | jq -r '.rule.id // .rule?._id // empty')

log "Evaluate Rule (dry-run)"
EVAL_STATUS=$(auth -X POST "$BASE_URL/api/admin/safety/rules/evaluate" --data "{\"entity_type\":\"snapshot\",\"entity_id\":\"$SNAP_ID\",\"operation\":\"restore\",\"properties\":{\"protection_level\":\"critical\"}}" -o /tmp/rule.eval -w '%{http_code}' || true)
cat /tmp/rule.eval > "$EVIDENCE_DIR/rule-eval-$TS.json"
assert "[ $EVAL_STATUS -eq 200 ]" "Rule eval status 200"
if command -v jq >/dev/null 2>&1; then
  assert "jq -e '.result.matched' /tmp/rule.eval >/dev/null" "Evaluation result present"
fi

log "Idempotency Check: repeat rule create"
IDEMP_RULE_PAYLOAD=$(cat <<JSON
{
  "rule_name":"$RULE_NAME",
  "description":"dup create should fail or dedupe",
  "target_type":"snapshot",
  "conditions":{
    "all":[
      {"field":"protection_level","operator":"eq","value":"critical"},
      {"field":"operation","operator":"eq","value":"restore"}
    ]
  },
  "effects":{"action":"block"},
  "priority":100,
  "is_active":true
}
JSON
)
IDEMP_STATUS=$(echo "$IDEMP_RULE_PAYLOAD" | auth -X POST "$BASE_URL/api/admin/safety/rules" --data @- -o /tmp/rule.dup -w '%{http_code}' || true)
cat /tmp/rule.dup > "$EVIDENCE_DIR/rule-create-duplicate-$TS.json"
assert "[ $IDEMP_STATUS -ne 201 ]" "Idempotency duplicate not re-created (status=$IDEMP_STATUS)"

log "Rate limiting check (11 quick GETs)"
RATE_LOG="$EVIDENCE_DIR/rate-limit-$TS.txt"
for i in {1..11}; do
  code=$(auth "$BASE_URL/api/admin/safety/rules" -o /dev/null -w '%{http_code}')
  echo "$i $code" | tee -a "$RATE_LOG" >/dev/null
done
last_code=$(tail -n1 "$RATE_LOG" | awk '{print $2}')
if [ $last_code -eq 429 ]; then
  echo "[PASS] Rate limit enforced (429)"
  pass_count=$((pass_count+1))
else
  echo "[WARN] Rate limit not enforced (last=$last_code)"
fi

log "Cleanup: Delete Rule"
if [[ -n "$RULE_ID" ]]; then
  auth -X DELETE "$BASE_URL/api/admin/safety/rules/$RULE_ID" | tee "$EVIDENCE_DIR/rule-delete-$TS.json" >/dev/null || true
fi

SUMMARY_FILE="$EVIDENCE_DIR/validation-summary-$TS.json"
echo "{\"snapshot_id\":\"$SNAP_ID\",\"passes\":$pass_count,\"fails\":$fail_count,\"timestamp\":\"$TS\",\"base_url\":\"$BASE_URL\"}" > "$SUMMARY_FILE"
log "Done (passes=$pass_count fails=$fail_count)"
exit $fail
