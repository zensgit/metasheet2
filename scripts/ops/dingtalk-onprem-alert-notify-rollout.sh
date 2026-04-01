#!/bin/bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SSH_USER_HOST="${SSH_USER_HOST:-mainuser@142.171.239.56}"
SSH_KEY="${SSH_KEY:-${HOME}/.ssh/metasheet2_deploy}"
REMOTE_APP_DIR="${REMOTE_APP_DIR:-/home/mainuser/metasheet2}"
REMOTE_OBS_DIR="${REMOTE_APP_DIR}/docker/observability"
REMOTE_PROM_RULES_DIR="${REMOTE_APP_DIR}/ops/prometheus"
REMOTE_ALERTMANAGER_ENV_FILE="${REMOTE_OBS_DIR}/alertmanager/alertmanager.onprem.env"
REMOTE_ALERT_WEBHOOK_RUNTIME_ENV_FILE="${REMOTE_OBS_DIR}/alertmanager/alert-webhook.runtime.env"
REMOTE_APP_NETWORK="${REMOTE_APP_NETWORK:-metasheet2_default}"
DOCKER_COMPOSE_BIN="${DOCKER_COMPOSE_BIN:-docker-compose}"
ALERTMANAGER_WEBHOOK_URL="${ALERTMANAGER_WEBHOOK_URL:-}"

ssh_cmd() {
  ssh -i "${SSH_KEY}" -o BatchMode=yes -o StrictHostKeyChecking=no "${SSH_USER_HOST}" "$@"
}

scp_cmd() {
  scp -i "${SSH_KEY}" -o BatchMode=yes -o StrictHostKeyChecking=no "$@"
}

copy_asset() {
  local local_path="$1"
  local remote_path="$2"
  ssh_cmd "mkdir -p \"$(dirname "${remote_path}")\""
  scp_cmd "${local_path}" "${SSH_USER_HOST}:${remote_path}"
}

write_alert_webhook_runtime_env() {
  local webhook_url="$1"
  local payload_b64
  payload_b64="$(ALERTMANAGER_WEBHOOK_URL_INPUT="${webhook_url}" python3 - <<'EOF'
import base64
import os

content = "# Managed by scripts/ops/dingtalk-onprem-alert-notify-rollout.sh\n" \
          f"ALERTMANAGER_WEBHOOK_URL={os.environ['ALERTMANAGER_WEBHOOK_URL_INPUT']}\n"
print(base64.b64encode(content.encode()).decode())
EOF
)"
  ssh_cmd "mkdir -p \"$(dirname "${REMOTE_ALERT_WEBHOOK_RUNTIME_ENV_FILE}")\" && tmp_file=\$(mktemp) && printf '%s' '${payload_b64}' | base64 -d > \"\${tmp_file}\" && install -m 600 \"\${tmp_file}\" '${REMOTE_ALERT_WEBHOOK_RUNTIME_ENV_FILE}' && rm -f \"\${tmp_file}\""
}

resolve_external_webhook_target() {
  if [ -n "${ALERTMANAGER_WEBHOOK_URL}" ]; then
    printf 'env-override\n%s\n' "${ALERTMANAGER_WEBHOOK_URL}"
    return 0
  fi

  local persisted_url
  persisted_url="$(ssh_cmd "CONFIG_FILE='${REMOTE_ALERTMANAGER_ENV_FILE}' python3 - <<'EOF'
import os
from pathlib import Path

path = Path(os.environ['CONFIG_FILE'])
if not path.exists():
    raise SystemExit(0)

content = path.read_text()
for line in content.splitlines():
    if line.startswith('ALERTMANAGER_WEBHOOK_URL='):
        print(line.split('=', 1)[1].strip())
        break
EOF" || true)"
  persisted_url="$(printf '%s' "${persisted_url}" | tr -d '\r')"
  if [ -n "${persisted_url}" ]; then
    printf 'remote-persisted\n%s\n' "${persisted_url}"
    return 0
  fi

  printf 'local-bridge-only\n\n'
}

build_alert_payload() {
  EXERCISE_ID_INPUT="$1" python3 - <<'EOF'
import json
import os
from datetime import datetime, timedelta, timezone

exercise_id = os.environ["EXERCISE_ID_INPUT"]
now = datetime.now(timezone.utc)
payload = [{
    "labels": {
        "alertname": "DingTalkOAuthAlertNotifyExercise",
        "severity": "warning",
        "feature": "dingtalk-oauth",
        "component": "auth",
        "exercise_id": exercise_id,
    },
    "annotations": {
        "summary": "DingTalk OAuth Alert Notify Exercise",
        "runbook": "Verify Alertmanager webhook delivery",
    },
    "startsAt": now.isoformat().replace("+00:00", "Z"),
    "endsAt": (now + timedelta(minutes=2)).isoformat().replace("+00:00", "Z"),
}]
print(json.dumps(payload, separators=(",", ":")))
EOF
}

echo "[onprem-alert-notify] syncing assets"
copy_asset "${ROOT_DIR}/docker/observability/docker-compose.onprem.yml" "${REMOTE_OBS_DIR}/docker-compose.onprem.yml"
copy_asset "${ROOT_DIR}/docker/observability/prometheus/prometheus.onprem.yml" "${REMOTE_OBS_DIR}/prometheus/prometheus.onprem.yml"
copy_asset "${ROOT_DIR}/docker/observability/alertmanager/webhook-receiver.py" "${REMOTE_OBS_DIR}/alertmanager/webhook-receiver.py"
copy_asset "${ROOT_DIR}/ops/prometheus/dingtalk-oauth-alerts.yml" "${REMOTE_PROM_RULES_DIR}/dingtalk-oauth-alerts.yml"
ssh_cmd "chmod 644 \"${REMOTE_OBS_DIR}/alertmanager/webhook-receiver.py\""

echo "[onprem-alert-notify] rendering Alertmanager config"
copy_asset "${ROOT_DIR}/docker/observability/alertmanager/alertmanager.onprem.yml.template" "${REMOTE_OBS_DIR}/alertmanager/alertmanager.onprem.yml"
ssh_cmd "chmod 644 \"${REMOTE_OBS_DIR}/alertmanager/alertmanager.onprem.yml\""
RESOLUTION_OUTPUT="$(resolve_external_webhook_target)"
RESOLVED_ALERTMANAGER_WEBHOOK_SOURCE="$(printf '%s\n' "${RESOLUTION_OUTPUT}" | sed -n '1p')"
RESOLVED_ALERTMANAGER_WEBHOOK_URL="$(printf '%s\n' "${RESOLUTION_OUTPUT}" | sed -n '2p')"
echo "[onprem-alert-notify] resolved external forward target source: ${RESOLVED_ALERTMANAGER_WEBHOOK_SOURCE}"
write_alert_webhook_runtime_env "${RESOLVED_ALERTMANAGER_WEBHOOK_URL}"

echo "[onprem-alert-notify] removing legacy Grafana datasource duplication"
ssh_cmd "rm -f \"${REMOTE_OBS_DIR}/grafana/provisioning/datasources/datasource.yml\""

echo "[onprem-alert-notify] removing stale Alertmanager containers for docker-compose v1 compatibility"
ssh_cmd "for name in metasheet-alertmanager metasheet-alert-webhook; do docker rm -f \"\${name}\" >/dev/null 2>&1 || true; done; stale_names=\$(docker ps -a --format '{{.Names}}' | grep -E 'metasheet-alertmanager|metasheet-alert-webhook' || true); if [ -n \"\${stale_names}\" ]; then printf '%s\n' \"\${stale_names}\" | xargs -r docker rm -f >/dev/null 2>&1; fi"

echo "[onprem-alert-notify] starting Alertmanager services without recreating the full observability stack"
ssh_cmd "cd \"${REMOTE_OBS_DIR}\" && METASHEET_APP_NETWORK=\"${REMOTE_APP_NETWORK}\" ${DOCKER_COMPOSE_BIN} -f docker-compose.onprem.yml up -d alertmanager alert-webhook"

echo "[onprem-alert-notify] restarting Prometheus to pick up alertmanager config"
ssh_cmd "docker restart metasheet-prometheus >/dev/null"

echo "[onprem-alert-notify] waiting for Prometheus after restart"
ssh_cmd "for i in \$(seq 1 30); do curl -fsS http://127.0.0.1:9090/-/healthy >/dev/null 2>&1 && exit 0; sleep 2; done; exit 1"

echo "[onprem-alert-notify] waiting for Alertmanager"
ssh_cmd "for i in \$(seq 1 30); do curl -fsS http://127.0.0.1:9093/-/healthy >/dev/null 2>&1 && exit 0; sleep 2; done; exit 1"

echo "[onprem-alert-notify] verifying Prometheus sees Alertmanager"
ssh_cmd "curl -fsS http://127.0.0.1:9090/api/v1/alertmanagers | grep -q 'alertmanager:9093'"

echo "[onprem-alert-notify] exercising webhook notification chain"
EXERCISE_ID="exercise-$(python3 - <<'EOF'
import time
print(int(time.time()))
EOF
)"
ALERT_PAYLOAD="$(build_alert_payload "${EXERCISE_ID}")"
ALERT_PAYLOAD_B64="$(printf '%s' "${ALERT_PAYLOAD}" | base64 | tr -d '\n')"
ssh_cmd "tmp_file=\$(mktemp) && printf '%s' '${ALERT_PAYLOAD_B64}' | base64 -d > \"\${tmp_file}\" && curl -fsS -H 'Content-Type: application/json' --data-binary @\"\${tmp_file}\" http://127.0.0.1:9093/api/v2/alerts >/dev/null && rm -f \"\${tmp_file}\""
ssh_cmd "for i in \$(seq 1 20); do output=\$(docker logs --since 3m metasheet-alert-webhook 2>&1 || true); case \"\${output}\" in *${EXERCISE_ID}*) exit 0 ;; esac; sleep 2; done; exit 1"

echo "[onprem-alert-notify] PASS"
