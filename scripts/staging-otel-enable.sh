#!/usr/bin/env bash
set -euo pipefail

# Staging OTEL enablement helper
# Requirements:
# - kubectl configured to target the staging cluster/namespace
# - curl and jq available locally
#
# Usage:
#   NAMESPACE=staging DEPLOY=metasheet-core-backend STAGING_HOST=staging.example.com \
#   OTEL_SERVICE_NAME=metasheet-staging \
#   bash metasheet-v2/scripts/staging-otel-enable.sh

NAMESPACE="${NAMESPACE:-staging}"
DEPLOY="${DEPLOY:-metasheet-core-backend}"
STAGING_HOST="${STAGING_HOST:-localhost}"
PORT="${PORT:-8900}"
OTEL_SERVICE_NAME="${OTEL_SERVICE_NAME:-metasheet-staging}"

echo "[staging-otel] Enabling FEATURE_OTEL on ${NAMESPACE}/${DEPLOY} ..."
kubectl -n "$NAMESPACE" set env deploy/"$DEPLOY" FEATURE_OTEL=true OTEL_SERVICE_NAME="$OTEL_SERVICE_NAME"
kubectl -n "$NAMESPACE" rollout status deploy/"$DEPLOY" --timeout=120s

echo "[staging-otel] Verifying endpoints on http://${STAGING_HOST}:${PORT} ..."
set +e
health=$(curl -fsS "http://${STAGING_HOST}:${PORT}/health" 2>/dev/null)
m1_code=$(curl -s -o /tmp/metrics_plain.txt -w "%{http_code}" "http://${STAGING_HOST}:${PORT}/metrics" 2>/dev/null)
m2_code=$(curl -s -o /tmp/metrics_otel.txt -w "%{http_code}" "http://${STAGING_HOST}:${PORT}/metrics/otel" 2>/dev/null)
has_help1=$(grep -c '^# HELP' /tmp/metrics_plain.txt 2>/dev/null || true)
has_help2=$(grep -c '^# HELP' /tmp/metrics_otel.txt 2>/dev/null || true)
set -e

echo "{\n  \"health\": ${health:-null},\n  \"metrics\": {\n    \"/metrics\": { \"code\": \"$m1_code\", \"hasHelp\": $has_help1 },\n    \"/metrics/otel\": { \"code\": \"$m2_code\", \"hasHelp\": $has_help2 }\n  }\n}"

echo "[staging-otel] Done. Monitor Prometheus targets and Grafana panels for 3–5 days."

