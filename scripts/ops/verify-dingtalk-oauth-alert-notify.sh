#!/bin/bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TEMPLATE_FILE="${ROOT_DIR}/docker/observability/alertmanager/alertmanager.onprem.yml.template"
CONFIG_EXAMPLE_FILE="${ROOT_DIR}/docker/observability/alertmanager/config.example.yml"
LOCAL_ALERTMANAGER_CONFIG="${ROOT_DIR}/docker/observability/alertmanager/alertmanager.onprem.yml"
ONPREM_COMPOSE_FILE="${ROOT_DIR}/docker/observability/docker-compose.onprem.yml"
ONPREM_PROM_CONFIG="${ROOT_DIR}/docker/observability/prometheus/prometheus.onprem.yml"
WEBHOOK_RECEIVER_FILE="${ROOT_DIR}/docker/observability/alertmanager/webhook-receiver.py"

cleanup_local_alertmanager_config() {
  if [ -f "${LOCAL_ALERTMANAGER_CONFIG}" ]; then
    rm -f "${LOCAL_ALERTMANAGER_CONFIG}"
  fi
}

trap cleanup_local_alertmanager_config EXIT

echo "[oauth-alert-notify] validating Alertmanager template YAML"
TEMPLATE_FILE_INPUT="${TEMPLATE_FILE}" python3 - <<'EOF'
from pathlib import Path
import os
import yaml

file_path = Path(os.environ["TEMPLATE_FILE_INPUT"])
parsed = yaml.safe_load(file_path.read_text())
assert isinstance(parsed, dict)
assert isinstance(parsed.get('route'), dict)
assert isinstance(parsed.get('receivers'), list) and parsed['receivers']
receiver_names = {receiver.get('name') for receiver in parsed['receivers'] if isinstance(receiver, dict)}
assert 'default-webhook' in receiver_names
assert 'local-test-webhook' in receiver_names
routes = parsed['route'].get('routes', [])
assert any('DingTalkOAuthAlertNotifyExercise' in ''.join(route.get('matchers', [])) for route in routes)
assert '__DEFAULT_WEBHOOK_URL__' in file_path.read_text()
print('[oauth-alert-notify] Alertmanager template parsed successfully')
EOF

echo "[oauth-alert-notify] validating webhook receiver asset"
test -f "${WEBHOOK_RECEIVER_FILE}"

echo "[oauth-alert-notify] preparing local rendered config for compose validation"
cp "${CONFIG_EXAMPLE_FILE}" "${LOCAL_ALERTMANAGER_CONFIG}"

echo "[oauth-alert-notify] validating on-prem compose wiring"
docker compose -f "${ONPREM_COMPOSE_FILE}" config >/dev/null

echo "[oauth-alert-notify] validating Prometheus alertmanager target"
grep -q "alertmanager:9093" "${ONPREM_PROM_CONFIG}"

echo "[oauth-alert-notify] PASS"
