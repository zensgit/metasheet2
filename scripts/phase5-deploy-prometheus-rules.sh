#!/usr/bin/env bash
set -euo pipefail

# Phase 5 Prometheus Rules Deployment Helper
# ------------------------------------------
# Validates recording + alerting rule files and prepares a deployment bundle.
# Optional: attempts a Prometheus config reload via the administrative API.
#
# Requirements (optional auto‑features):
#   - promtool (preferred) for rule linting
#   - curl (for /-/reload endpoint)
#
# Environment Variables:
#   PROMETHEUS_RULES_DIR   Target directory on Prometheus host (for scp copy) [optional]
#   PROMETHEUS_HOST        SSH host for scp transfer (user@host)             [optional]
#   PROMETHEUS_URL         Base URL for Prometheus (e.g. https://prom:9090)  [optional]
#   SKIP_RELOAD            Set to 'true' to skip calling /-/reload           [optional]
#   DRY_RUN               Set to 'true' to only lint & bundle               [optional]
#
# Usage Examples:
#   bash scripts/phase5-deploy-prometheus-rules.sh
#   PROMETHEUS_URL=http://localhost:9090 bash scripts/phase5-deploy-prometheus-rules.sh
#   PROMETHEUS_HOST=ops@prometheus.local PROMETHEUS_RULES_DIR=/etc/prometheus/rules \
#     bash scripts/phase5-deploy-prometheus-rules.sh
#
# Output:
#   - ./artifacts/phase5-prometheus-bundle/phase5-recording-rules.yml
#   - ./artifacts/phase5-prometheus-bundle/phase5-alerts.yml

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ARTIFACT_DIR="${ROOT_DIR}/artifacts/phase5-prometheus-bundle"
mkdir -p "${ARTIFACT_DIR}"

RECORDING_SRC="${ROOT_DIR}/ops/prometheus/phase5-recording-rules.yml"
ALERTS_SRC="${ROOT_DIR}/ops/prometheus/phase5-alerts.yml"

cp "${RECORDING_SRC}" "${ARTIFACT_DIR}/phase5-recording-rules.yml"
cp "${ALERTS_SRC}" "${ARTIFACT_DIR}/phase5-alerts.yml"

echo "[phase5] Bundle prepared under ${ARTIFACT_DIR}" >&2

lint_with_promtool() {
  local file="$1"
  if command -v promtool >/dev/null 2>&1; then
    promtool check rules "$file"
  else
    echo "[phase5][warn] promtool not installed; performing basic YAML parse: $file" >&2
    python - <<'PY' "$file" || exit 1
import sys, yaml
path=sys.argv[1]
with open(path,'r',encoding='utf-8') as f:
    yaml.safe_load(f)
print(f"BASIC_YAML_OK {path}")
PY
  fi
}

echo "[phase5] Linting recording rules" >&2
lint_with_promtool "${ARTIFACT_DIR}/phase5-recording-rules.yml"
echo "[phase5] Linting alert rules" >&2
lint_with_promtool "${ARTIFACT_DIR}/phase5-alerts.yml"

if [ "${DRY_RUN:-false}" = "true" ]; then
  echo "[phase5] DRY_RUN=true; skipping deployment & reload." >&2
  exit 0
fi

# Optional SCP deployment
if [ -n "${PROMETHEUS_HOST:-}" ] && [ -n "${PROMETHEUS_RULES_DIR:-}" ]; then
  echo "[phase5] Deploying bundle to ${PROMETHEUS_HOST}:${PROMETHEUS_RULES_DIR}" >&2
  scp "${ARTIFACT_DIR}/phase5-recording-rules.yml" "${PROMETHEUS_HOST}:${PROMETHEUS_RULES_DIR}/" || echo "[phase5][warn] SCP failed (recording)." >&2
  scp "${ARTIFACT_DIR}/phase5-alerts.yml" "${PROMETHEUS_HOST}:${PROMETHEUS_RULES_DIR}/" || echo "[phase5][warn] SCP failed (alerts)." >&2
else
  echo "[phase5] PROMETHEUS_HOST or PROMETHEUS_RULES_DIR not set; skipping SCP copy." >&2
fi

# Optional config reload
if [ -n "${PROMETHEUS_URL:-}" ] && [ "${SKIP_RELOAD:-false}" != "true" ]; then
  echo "[phase5] Attempting Prometheus config reload via ${PROMETHEUS_URL}/-/reload" >&2
  if curl -fsS -X POST "${PROMETHEUS_URL}/-/reload" >/dev/null; then
    echo "[phase5] Prometheus reload requested successfully." >&2
  else
    echo "[phase5][warn] Prometheus reload endpoint failed or unsupported." >&2
  fi
else
  echo "[phase5] PROMETHEUS_URL not set or SKIP_RELOAD=true; skipping reload." >&2
fi

echo "[phase5] Done." >&2

