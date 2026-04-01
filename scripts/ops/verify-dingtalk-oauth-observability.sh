#!/bin/bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RULES_DIR="${ROOT_DIR}/ops/prometheus"
DASHBOARD_JSON="${ROOT_DIR}/docker/observability/grafana/dashboards/dingtalk-oauth-overview.json"
COMPOSE_FILE="${ROOT_DIR}/docker/observability/docker-compose.yml"
PROM_CONFIG="${ROOT_DIR}/docker/observability/prometheus/prometheus.yml"
METRICS_FILE="${ROOT_DIR}/packages/core-backend/src/metrics/metrics.ts"

echo "[oauth-observability] validating dashboard JSON"
node --input-type=module -e "JSON.parse(await import('node:fs').then(m => m.readFileSync(process.argv[1], 'utf8')))" "${DASHBOARD_JSON}" >/dev/null

echo "[oauth-observability] validating metric definitions"
rg -q 'metasheet_dingtalk_oauth_state_operations_total' "${METRICS_FILE}"
rg -q 'metasheet_dingtalk_oauth_state_fallback_total' "${METRICS_FILE}"
rg -q 'redis_operation_duration_seconds' "${METRICS_FILE}"

echo "[oauth-observability] validating docker compose wiring"
docker compose -f "${COMPOSE_FILE}" config >/dev/null

check_rules_with_promtool() {
  promtool check rules \
    "${RULES_DIR}/phase5-recording-rules.yml" \
    "${RULES_DIR}/phase5-alerts.yml" \
    "${RULES_DIR}/attendance-alerts.yml" \
    "${RULES_DIR}/dingtalk-oauth-alerts.yml"

  promtool check config "${PROM_CONFIG}"
}

check_rules_with_yaml_fallback() {
  node --input-type=module - <<'EOF'
import fs from 'node:fs'
import yaml from 'js-yaml'

const files = [
  'ops/prometheus/phase5-recording-rules.yml',
  'ops/prometheus/phase5-alerts.yml',
  'ops/prometheus/attendance-alerts.yml',
  'ops/prometheus/dingtalk-oauth-alerts.yml',
]

for (const relativePath of files) {
  const source = fs.readFileSync(relativePath, 'utf8')
  const parsed = yaml.load(source)
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.groups)) {
    throw new Error(`invalid rules file: ${relativePath} (missing groups array)`)
  }

  for (const group of parsed.groups) {
    if (!group || typeof group !== 'object' || typeof group.name !== 'string' || !Array.isArray(group.rules)) {
      throw new Error(`invalid rule group in ${relativePath}`)
    }
    for (const rule of group.rules) {
      if (!rule || typeof rule !== 'object') {
        throw new Error(`invalid rule entry in ${relativePath}`)
      }
      if (typeof rule.alert === 'string') {
        if (typeof rule.expr !== 'string') {
          throw new Error(`alert rule missing expr in ${relativePath}`)
        }
      } else if (typeof rule.record === 'string') {
        if (typeof rule.expr !== 'string') {
          throw new Error(`recording rule missing expr in ${relativePath}`)
        }
      } else {
        throw new Error(`rule missing alert/record key in ${relativePath}`)
      }
    }
  }
}

console.log('[oauth-observability] rules parsed successfully via YAML fallback')
EOF
}

echo "[oauth-observability] validating Prometheus rules"
if command -v promtool >/dev/null 2>&1; then
  check_rules_with_promtool
elif docker info >/dev/null 2>&1; then
  docker run --rm \
    -v "${RULES_DIR}:/rules:ro" \
    prom/prometheus:v2.48.0 \
    promtool check rules \
    /rules/phase5-recording-rules.yml \
    /rules/phase5-alerts.yml \
    /rules/attendance-alerts.yml \
    /rules/dingtalk-oauth-alerts.yml

  docker run --rm \
    -v "${ROOT_DIR}/docker/observability/prometheus:/etc/prometheus:ro" \
    -v "${RULES_DIR}:/etc/prometheus/rules:ro" \
    prom/prometheus:v2.48.0 \
    promtool check config /etc/prometheus/prometheus.yml
else
  echo "[oauth-observability] promtool and Docker daemon unavailable; using YAML structural validation fallback"
  (cd "${ROOT_DIR}" && check_rules_with_yaml_fallback)
fi

echo "[oauth-observability] verification passed"
