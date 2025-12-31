#!/usr/bin/env bash
set -euo pipefail

BASE_URL=${1:-http://127.0.0.1:7778}
JWT_SECRET=${JWT_SECRET:-dev-secret-key}
USER_ID=${USER_ID:-dev-workflow-admin}
JWT_TENANT_ID=${JWT_TENANT_ID:-}

RUN_ID=$(date +%s)
WF_KEY=${WF_KEY:-demo-process-$RUN_ID}
WF_NAME=${WF_NAME:-Demo Process $RUN_ID}
WF_CATEGORY=${WF_CATEGORY:-demo}

TOKEN=$(JWT_SECRET="$JWT_SECRET" USER_ID="$USER_ID" JWT_TENANT_ID="$JWT_TENANT_ID" node scripts/gen-dev-token.js)

request() {
  local method=$1
  local url=$2
  local data=${3:-}
  local expected=${4:-200}
  local response
  if [[ -n "$data" ]]; then
    response=$(curl -s -w "\n%{http_code}" -X "$method" "$url" \
      -H "Authorization: Bearer $TOKEN" \
      -H 'Content-Type: application/json' \
      -d "$data")
  else
    response=$(curl -s -w "\n%{http_code}" -X "$method" "$url" \
      -H "Authorization: Bearer $TOKEN")
  fi

  local body=${response%$'\n'*}
  local status=${response##*$'\n'}
  if [[ "$status" != "$expected" ]]; then
    echo "Request failed ($method $url) status=$status expected=$expected"
    echo "$body"
    exit 1
  fi
  echo "$body"
}

BODY=$(WF_KEY="$WF_KEY" WF_NAME="$WF_NAME" WF_CATEGORY="$WF_CATEGORY" python3 - <<'PY'
import json
import os
key = os.environ['WF_KEY']
name = os.environ['WF_NAME']
category = os.environ['WF_CATEGORY']
xml = f"""<?xml version=\"1.0\" encoding=\"UTF-8\"?>
<bpmn:definitions xmlns:bpmn=\"http://www.omg.org/spec/BPMN/20100524/MODEL\"
                  xmlns:xsi=\"http://www.w3.org/2001/XMLSchema-instance\"
                  targetNamespace=\"http://example.com/bpmn\">
  <bpmn:process id=\"{key}\" name=\"{name}\" isExecutable=\"true\">
    <bpmn:startEvent id=\"StartEvent_1\" />
    <bpmn:endEvent id=\"EndEvent_1\" />
    <bpmn:sequenceFlow id=\"Flow_1\" sourceRef=\"StartEvent_1\" targetRef=\"EndEvent_1\" />
  </bpmn:process>
</bpmn:definitions>
"""
print(json.dumps({"key": key, "name": name, "category": category, "bpmnXml": xml}))
PY
)

DEPLOY_RES=$(request POST "$BASE_URL/api/workflow/deploy" "$BODY" 201)
DEF_ID=$(printf '%s' "$DEPLOY_RES" | python3 -c 'import json,sys; res=json.load(sys.stdin); print(res["data"]["definitionId"])')

echo "Deployed definition: $DEF_ID"

LIST_RES=$(request GET "$BASE_URL/api/workflow/definitions?category=$WF_CATEGORY" "" 200)
printf '%s' "$LIST_RES" | WF_KEY="$WF_KEY" python3 -c 'import json,sys,os; res=json.load(sys.stdin); items=res.get("data",[]); keys=[item.get("key") for item in items];
if os.environ["WF_KEY"] not in keys: raise SystemExit(f"Definition key not found: {keys}")'

START_RES=$(request POST "$BASE_URL/api/workflow/start/$WF_KEY" '{"variables":{"foo":"bar"}}' 201)
INST_ID=$(printf '%s' "$START_RES" | python3 -c 'import json,sys; res=json.load(sys.stdin); print(res["data"]["instanceId"])')

echo "Started instance: $INST_ID"

INSTANCES=$(request GET "$BASE_URL/api/workflow/instances?processKey=$WF_KEY" "" 200)
printf '%s' "$INSTANCES" | INST_ID="$INST_ID" python3 -c 'import json,sys,os; res=json.load(sys.stdin); items=res.get("data",[]); ids=[item.get("id") for item in items];
if os.environ["INST_ID"] not in ids: raise SystemExit(f"Instance id not found: {ids}")'

echo "Workflow minimal verification passed"
