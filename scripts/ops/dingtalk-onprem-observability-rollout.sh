#!/bin/bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SSH_USER_HOST="${SSH_USER_HOST:-mainuser@142.171.239.56}"
SSH_KEY="${SSH_KEY:-${HOME}/.ssh/metasheet2_deploy}"
REMOTE_APP_DIR="${REMOTE_APP_DIR:-/home/mainuser/metasheet2}"
REMOTE_OBS_DIR="${REMOTE_APP_DIR}/docker/observability"
REMOTE_PROM_RULES_DIR="${REMOTE_APP_DIR}/ops/prometheus"
REMOTE_APP_NETWORK="${REMOTE_APP_NETWORK:-metasheet2_default}"
DOCKER_COMPOSE_BIN="${DOCKER_COMPOSE_BIN:-docker-compose}"

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

echo "[onprem-observability] syncing assets"
copy_asset "${ROOT_DIR}/docker/observability/docker-compose.onprem.yml" "${REMOTE_OBS_DIR}/docker-compose.onprem.yml"
copy_asset "${ROOT_DIR}/docker/observability/prometheus/prometheus.onprem.yml" "${REMOTE_OBS_DIR}/prometheus/prometheus.onprem.yml"
copy_asset "${ROOT_DIR}/docker/observability/grafana/dashboards/dingtalk-oauth-overview.json" "${REMOTE_OBS_DIR}/grafana/dashboards/dingtalk-oauth-overview.json"
copy_asset "${ROOT_DIR}/ops/prometheus/dingtalk-oauth-alerts.yml" "${REMOTE_PROM_RULES_DIR}/dingtalk-oauth-alerts.yml"

echo "[onprem-observability] removing legacy Grafana datasource duplication"
ssh_cmd "rm -f \"${REMOTE_OBS_DIR}/grafana/provisioning/datasources/datasource.yml\""

echo "[onprem-observability] starting Prometheus + Grafana"
ssh_cmd "cd \"${REMOTE_OBS_DIR}\" && METASHEET_APP_NETWORK=\"${REMOTE_APP_NETWORK}\" ${DOCKER_COMPOSE_BIN} -f docker-compose.onprem.yml up -d"

echo "[onprem-observability] waiting for Prometheus"
ssh_cmd "for i in \$(seq 1 30); do curl -fsS http://127.0.0.1:9090/-/healthy >/dev/null 2>&1 && exit 0; sleep 2; done; exit 1"

echo "[onprem-observability] waiting for Grafana"
ssh_cmd "for i in \$(seq 1 45); do curl -fsS http://127.0.0.1:3000/api/health >/dev/null 2>&1 && exit 0; sleep 2; done; exit 1"

echo "[onprem-observability] verifying Prometheus target"
ssh_cmd "curl -fsS http://127.0.0.1:9090/api/v1/targets | grep -q '\"job\":\"metasheet-backend\"' && curl -fsS http://127.0.0.1:9090/api/v1/targets | grep -q '\"health\":\"up\"'"

echo "[onprem-observability] verifying Grafana dashboard registration"
ssh_cmd "curl -fsS -u admin:admin 'http://127.0.0.1:3000/api/search?query=DingTalk%20OAuth%20Overview' | grep -q 'dingtalk-oauth-overview'"

echo "[onprem-observability] PASS"
