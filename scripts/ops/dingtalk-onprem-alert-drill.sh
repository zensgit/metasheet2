#!/bin/bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SSH_USER_HOST="${SSH_USER_HOST:-mainuser@142.171.239.56}"
SSH_KEY="${SSH_KEY:-${HOME}/.ssh/metasheet2_deploy}"
DRILL_ALERT_NAME="${DRILL_ALERT_NAME:-DingTalkOAuthSlackChannelDrill}"
DRILL_DURATION_SECONDS="${DRILL_DURATION_SECONDS:-20}"
DRILL_WAIT_SECONDS="${DRILL_WAIT_SECONDS:-120}"
JSON_OUTPUT="${JSON_OUTPUT:-false}"

ssh_cmd() {
  ssh -i "${SSH_KEY}" -o BatchMode=yes -o StrictHostKeyChecking=no "${SSH_USER_HOST}" "$@"
}

build_alert_payload() {
  DRILL_ALERT_NAME_INPUT="${DRILL_ALERT_NAME}" \
  DRILL_DURATION_SECONDS_INPUT="${DRILL_DURATION_SECONDS}" \
  python3 - <<'EOF'
import json
import os
from datetime import datetime, timedelta, timezone

name = os.environ['DRILL_ALERT_NAME_INPUT']
duration_seconds = int(os.environ['DRILL_DURATION_SECONDS_INPUT'])
now = datetime.now(timezone.utc)
drill_id = f"drill-{int(now.timestamp())}"
payload = [{
    "labels": {
        "alertname": name,
        "severity": "warning",
        "component": "auth",
        "feature": "dingtalk-oauth",
        "drill_id": drill_id,
    },
    "annotations": {
        "summary": "DingTalk OAuth Slack channel drill",
        "runbook": "Confirm firing and resolved notifications land in #metasheet-alerts",
    },
    "startsAt": now.isoformat().replace("+00:00", "Z"),
    "endsAt": (now + timedelta(seconds=duration_seconds)).isoformat().replace("+00:00", "Z"),
}]
print(json.dumps({"drill_id": drill_id, "payload": payload}, separators=(",", ":")))
EOF
}

wait_for_state() {
  local drill_id="$1"
  local expected="$2"
  local max_attempts="$3"
  for _ in $(seq 1 "${max_attempts}"); do
    if ssh_cmd "DRILL_ID='${drill_id}' EXPECTED_STATE='${expected}' python3 - <<'EOF'
import json
import os
import urllib.request

drill_id = os.environ['DRILL_ID']
expected = os.environ['EXPECTED_STATE']
with urllib.request.urlopen('http://127.0.0.1:9093/api/v2/alerts', timeout=10) as response:
    alerts = json.loads(response.read().decode())

present = any((alert.get('labels') or {}).get('drill_id') == drill_id for alert in alerts)
if expected == 'present' and present:
    raise SystemExit(0)
if expected == 'absent' and not present:
    raise SystemExit(0)
raise SystemExit(1)
EOF"; then
      return 0
    fi
    sleep 2
  done
  return 1
}

POSTED_JSON="$(build_alert_payload)"
DRILL_ID="$(POSTED_JSON_INPUT="${POSTED_JSON}" python3 - <<'EOF'
import json
import os

print(json.loads(os.environ['POSTED_JSON_INPUT'])['drill_id'])
EOF
)"
ALERT_PAYLOAD="$(POSTED_JSON_INPUT="${POSTED_JSON}" python3 - <<'EOF'
import json
import os

print(json.dumps(json.loads(os.environ['POSTED_JSON_INPUT'])['payload'], separators=(",", ":")))
EOF
)"
ALERT_PAYLOAD_B64="$(printf '%s' "${ALERT_PAYLOAD}" | base64 | tr -d '\n')"

echo "[onprem-alert-drill] posting ${DRILL_ALERT_NAME} (${DRILL_ID})"
ssh_cmd "tmp_file=\$(mktemp) && printf '%s' '${ALERT_PAYLOAD_B64}' | base64 -d > \"\${tmp_file}\" && curl -fsS -H 'Content-Type: application/json' --data-binary @\"\${tmp_file}\" http://127.0.0.1:9093/api/v2/alerts >/dev/null && rm -f \"\${tmp_file}\""

echo "[onprem-alert-drill] waiting for firing state"
wait_for_state "${DRILL_ID}" "present" 10

echo "[onprem-alert-drill] waiting for resolved state"
wait_for_state "${DRILL_ID}" "absent" "$(( DRILL_WAIT_SECONDS / 2 ))"

if [ "${JSON_OUTPUT}" = "true" ]; then
  DRILL_ID_INPUT="${DRILL_ID}" \
  DRILL_ALERT_NAME_INPUT="${DRILL_ALERT_NAME}" \
  python3 - <<'EOF'
import json
import os

print(json.dumps({
    "alertName": os.environ["DRILL_ALERT_NAME_INPUT"],
    "drillId": os.environ["DRILL_ID_INPUT"],
    "firingObserved": True,
    "resolvedObserved": True,
}, ensure_ascii=False))
EOF
else
  echo "[onprem-alert-drill] PASS"
  echo "alertName=${DRILL_ALERT_NAME}"
  echo "drillId=${DRILL_ID}"
  echo "firingObserved=true"
  echo "resolvedObserved=true"
fi
