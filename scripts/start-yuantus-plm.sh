#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
YUANTUS_ROOT="${YUANTUS_ROOT:-$ROOT_DIR/../Yuantus}"
COMPOSE_FILE="${COMPOSE_FILE:-$YUANTUS_ROOT/docker-compose.yml}"

PLM_BASE_URL="${PLM_BASE_URL:-http://127.0.0.1:7910}"
PLM_TENANT_ID="${PLM_TENANT_ID:-tenant-1}"
PLM_ORG_ID="${PLM_ORG_ID:-org-1}"
PLM_USERNAME="${PLM_USERNAME:-admin}"
PLM_PASSWORD="${PLM_PASSWORD:-admin}"

IDENTITY_DB_URL="${YUANTUS_IDENTITY_DATABASE_URL:-postgresql+psycopg://yuantus:yuantus@postgres:5432/yuantus}"
PRINT_TOKEN="${PRINT_TOKEN:-false}"

if [[ ! -f "$COMPOSE_FILE" ]]; then
  echo "Yuantus compose file not found: $COMPOSE_FILE" >&2
  exit 1
fi

export YUANTUS_IDENTITY_DATABASE_URL="$IDENTITY_DB_URL"

echo "Starting Yuantus services..."
docker compose -f "$COMPOSE_FILE" up -d --force-recreate api worker

echo "Waiting for PLM health..."
for _ in {1..30}; do
  if curl -fsS "$PLM_BASE_URL/api/v1/health" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
if ! curl -fsS "$PLM_BASE_URL/api/v1/health" >/dev/null 2>&1; then
  echo "PLM health check failed at $PLM_BASE_URL/api/v1/health" >&2
  exit 1
fi

PLM_TOKEN="$(
  curl -sS -X POST "$PLM_BASE_URL/api/v1/auth/login" \
    -H "Content-Type: application/json" \
    -H "x-tenant-id: $PLM_TENANT_ID" \
    -H "x-org-id: $PLM_ORG_ID" \
    -d "{\"username\":\"$PLM_USERNAME\",\"password\":\"$PLM_PASSWORD\",\"tenant_id\":\"$PLM_TENANT_ID\",\"org_id\":\"$PLM_ORG_ID\"}" \
    | python3 -c 'import json,sys; print(json.load(sys.stdin).get("access_token",""))' || true
)"

if [[ -z "$PLM_TOKEN" ]]; then
  echo "Seeding identity (admin)..." >&2
  API_CONTAINER="$(docker compose -f "$COMPOSE_FILE" ps -q api)"
  if [[ -z "$API_CONTAINER" ]]; then
    echo "Failed to resolve api container id." >&2
    exit 1
  fi
  docker exec "$API_CONTAINER" yuantus seed-identity \
    --tenant "$PLM_TENANT_ID" \
    --org "$PLM_ORG_ID" \
    --username "$PLM_USERNAME" \
    --password "$PLM_PASSWORD" \
    --user-id 1 \
    --roles admin \
    --superuser

  PLM_TOKEN="$(
    curl -sS -X POST "$PLM_BASE_URL/api/v1/auth/login" \
      -H "Content-Type: application/json" \
      -H "x-tenant-id: $PLM_TENANT_ID" \
      -H "x-org-id: $PLM_ORG_ID" \
      -d "{\"username\":\"$PLM_USERNAME\",\"password\":\"$PLM_PASSWORD\",\"tenant_id\":\"$PLM_TENANT_ID\",\"org_id\":\"$PLM_ORG_ID\"}" \
      | python3 -c 'import json,sys; print(json.load(sys.stdin).get("access_token",""))' || true
  )"
fi

if [[ -z "$PLM_TOKEN" ]]; then
  echo "Failed to obtain PLM token after seeding." >&2
  exit 1
fi

echo "Yuantus PLM ready: $PLM_BASE_URL"
if [[ "$PRINT_TOKEN" == "true" ]]; then
  echo "PLM_API_TOKEN=$PLM_TOKEN"
fi
