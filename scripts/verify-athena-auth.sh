#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

KEYCLOAK_URL="${KEYCLOAK_URL:-http://localhost:8180}"
KEYCLOAK_REALM="${KEYCLOAK_REALM:-ecm}"
KEYCLOAK_CLIENT_ID="${KEYCLOAK_CLIENT_ID:-unified-portal}"
KEYCLOAK_CLIENT_SECRET="${KEYCLOAK_CLIENT_SECRET:-}"
KEYCLOAK_USER="${KEYCLOAK_USER:-admin}"
KEYCLOAK_PASSWORD="${KEYCLOAK_PASSWORD:-admin}"

ATHENA_BASE_URL="${ATHENA_BASE_URL:-http://localhost:8081}"
ATHENA_HEALTH_PATH="${ATHENA_HEALTH_PATH:-/actuator/health}"
ATHENA_PING_PATH="${ATHENA_PING_PATH:-/api/v1/health}"

REPORT_DIR="${REPORT_DIR:-docs}"
STAMP="${STAMP:-$(date +%Y%m%d_%H%M%S)}"
REPORT_PATH="${REPORT_DIR}/verification-athena-auth-${STAMP}.md"

mkdir -p "$REPORT_DIR"

token_request="grant_type=password&client_id=${KEYCLOAK_CLIENT_ID}&username=${KEYCLOAK_USER}&password=${KEYCLOAK_PASSWORD}"
if [[ -n "${KEYCLOAK_CLIENT_SECRET}" ]]; then
  token_request="${token_request}&client_secret=${KEYCLOAK_CLIENT_SECRET}"
fi

TOKEN_RESPONSE="$(curl -sS -X POST "${KEYCLOAK_URL}/realms/${KEYCLOAK_REALM}/protocol/openid-connect/token" \
  -H 'content-type: application/x-www-form-urlencoded' \
  -d "${token_request}" || true)"

ACCESS_TOKEN="$(python3 - <<'PY' "$TOKEN_RESPONSE"
import json
import sys

payload = sys.argv[1] if len(sys.argv) > 1 else ''
try:
    data = json.loads(payload) if payload else {}
except Exception:
    data = {}
print(data.get("access_token",""))
PY
)"

token_status="ok"
if [[ -z "$ACCESS_TOKEN" ]]; then
  token_status="missing"
fi

health_code="$(curl -s -o /tmp/athena-health.json -w '%{http_code}' \
  "${ATHENA_BASE_URL}${ATHENA_HEALTH_PATH}" || true)"

ping_code="skipped"
if [[ -n "$ATHENA_PING_PATH" ]]; then
  ping_code="$(curl -s -o /tmp/athena-ping.json -w '%{http_code}' \
    -H "Authorization: Bearer ${ACCESS_TOKEN}" \
    "${ATHENA_BASE_URL}${ATHENA_PING_PATH}" || true)"
fi

cat > "$REPORT_PATH" <<EOF
# Verification: Athena Auth Smoke - ${STAMP}

## Environment
- Keycloak: ${KEYCLOAK_URL}
- Realm: ${KEYCLOAK_REALM}
- Client: ${KEYCLOAK_CLIENT_ID}
- Athena base: ${ATHENA_BASE_URL}

## Token
- Status: ${token_status}

## Endpoints
- Health (${ATHENA_HEALTH_PATH}): HTTP ${health_code}
- Authenticated ping (${ATHENA_PING_PATH}): HTTP ${ping_code}

## Notes
- Provide KEYCLOAK_CLIENT_SECRET if using a confidential client (e.g. \`ecm-api\`).
EOF

echo "Report: $REPORT_PATH"
