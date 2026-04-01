#!/bin/bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SSH_USER_HOST="${SSH_USER_HOST:-mainuser@142.171.239.56}"
SSH_KEY="${SSH_KEY:-${HOME}/.ssh/metasheet2_deploy}"
RESTORE_LOCAL_NOTIFY="${RESTORE_LOCAL_NOTIFY:-true}"
WEBHOOK_SITE_TOKEN="${WEBHOOK_SITE_TOKEN:-}"

ROLLBACK_DONE="false"

cleanup() {
  if [ "${RESTORE_LOCAL_NOTIFY}" = "true" ] && [ "${ROLLBACK_DONE}" != "true" ]; then
    bash "${ROOT_DIR}/scripts/ops/set-dingtalk-onprem-alertmanager-webhook-config.sh" --clear >/dev/null 2>&1 || true
    if bash "${ROOT_DIR}/scripts/ops/dingtalk-onprem-alert-notify-rollout.sh" >/dev/null 2>&1; then
      ROLLBACK_DONE="true"
    fi
  fi
}

trap cleanup EXIT

create_webhook_site_token() {
  python3 - <<'EOF'
import json
import urllib.request

payload = json.dumps({
    "default_status": 200,
    "request_limit": 20,
    "expiry": 3600,
}).encode()
request = urllib.request.Request(
    "https://webhook.site/token",
    data=payload,
    headers={"Content-Type": "application/json"},
)
with urllib.request.urlopen(request, timeout=20) as response:
    body = json.loads(response.read().decode())
print(body["uuid"])
EOF
}

fetch_webhook_site_requests() {
  local token="$1"
  python3 - <<'EOF' "${token}"
import sys
import urllib.request

token = sys.argv[1]
url = f"https://webhook.site/token/{token}/requests?sorting=newest&per_page=5"
with urllib.request.urlopen(url, timeout=20) as response:
    print(response.read().decode())
EOF
}

send_external_exercise() {
  local exercise_id="$1"
  local payload_b64
  payload_b64="$(EXERCISE_ID_INPUT="${exercise_id}" python3 - <<'EOF'
import json
import os
from datetime import datetime, timedelta, timezone

exercise_id = os.environ["EXERCISE_ID_INPUT"]
now = datetime.now(timezone.utc)
payload = [{
    "labels": {
        "alertname": "DingTalkOAuthExternalWebhookExercise",
        "severity": "warning",
        "feature": "dingtalk-oauth",
        "component": "auth",
        "exercise_id": exercise_id,
    },
    "annotations": {
        "summary": "DingTalk OAuth External Webhook Exercise",
        "runbook": "Verify external Alertmanager webhook delivery",
    },
    "startsAt": now.isoformat().replace("+00:00", "Z"),
    "endsAt": (now + timedelta(minutes=2)).isoformat().replace("+00:00", "Z"),
}]
print(json.dumps(payload, separators=(",", ":")))
EOF
)"
  payload_b64="$(printf '%s' "${payload_b64}" | base64 | tr -d '\n')"

  ssh -i "${SSH_KEY}" -o BatchMode=yes -o StrictHostKeyChecking=no "${SSH_USER_HOST}" \
    "tmp_file=\$(mktemp) && printf '%s' '${payload_b64}' | base64 -d > \"\${tmp_file}\" && curl -fsS -H 'Content-Type: application/json' --data-binary @\"\${tmp_file}\" http://127.0.0.1:9093/api/v2/alerts >/dev/null && rm -f \"\${tmp_file}\""
}

if [ -z "${WEBHOOK_SITE_TOKEN}" ]; then
  echo "[oauth-alert-notify-webhooksite] creating temporary Webhook.site token"
  WEBHOOK_SITE_TOKEN="$(create_webhook_site_token)"
fi

WEBHOOK_URL="https://webhook.site/${WEBHOOK_SITE_TOKEN}"
EXERCISE_ID="external-$(date +%s)"

echo "[oauth-alert-notify-webhooksite] writing persistent external webhook config"
ALERTMANAGER_WEBHOOK_URL="${WEBHOOK_URL}" bash "${ROOT_DIR}/scripts/ops/set-dingtalk-onprem-alertmanager-webhook-config.sh"
echo "[oauth-alert-notify-webhooksite] rollout using persisted webhook config"
bash "${ROOT_DIR}/scripts/ops/dingtalk-onprem-alert-notify-rollout.sh"

echo "[oauth-alert-notify-webhooksite] sending external notification exercise"
send_external_exercise "${EXERCISE_ID}"

echo "[oauth-alert-notify-webhooksite] polling Webhook.site capture"
for _ in $(seq 1 20); do
  requests_json="$(fetch_webhook_site_requests "${WEBHOOK_SITE_TOKEN}")"
  if printf '%s' "${requests_json}" | grep -q "${EXERCISE_ID}"; then
    echo "[oauth-alert-notify-webhooksite] PASS"
    echo "${requests_json}"
    if [ "${RESTORE_LOCAL_NOTIFY}" = "true" ]; then
      echo "[oauth-alert-notify-webhooksite] restoring local default receiver by clearing persisted config"
      bash "${ROOT_DIR}/scripts/ops/set-dingtalk-onprem-alertmanager-webhook-config.sh" --clear >/dev/null
      bash "${ROOT_DIR}/scripts/ops/dingtalk-onprem-alert-notify-rollout.sh" >/dev/null
      ROLLBACK_DONE="true"
    fi
    exit 0
  fi
  sleep 2
done

echo "[oauth-alert-notify-webhooksite] failed to observe external webhook delivery" >&2
exit 1
