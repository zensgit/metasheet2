#!/usr/bin/env bash
set -euo pipefail

API_BASE="${API_BASE:-}"
AUTH_TOKEN="${AUTH_TOKEN:-}"
USER_ID="${USER_ID:-}"
ROLE="${ROLE:-}"

function die() {
  echo "[attendance-provision-user] ERROR: $*" >&2
  exit 1
}

function info() {
  echo "[attendance-provision-user] $*" >&2
}

function usage() {
  cat >&2 <<'EOF'
Usage:
  API_BASE="http://HOST:PORT/api" AUTH_TOKEN="<ADMIN_JWT>" USER_ID="<UUID>" ROLE="employee|approver|admin" \
    scripts/ops/attendance-provision-user.sh

Notes:
  - This script grants attendance permissions via POST /api/permissions/grant.
  - It requires an ADMIN token (the backend enforces admin-only permission grants).
EOF
}

[[ -n "$API_BASE" ]] || { usage; die "API_BASE is required"; }
[[ -n "$AUTH_TOKEN" ]] || { usage; die "AUTH_TOKEN is required"; }
[[ -n "$USER_ID" ]] || { usage; die "USER_ID is required"; }
[[ -n "$ROLE" ]] || { usage; die "ROLE is required"; }

# Normalize API_BASE to not end with "/".
API_BASE="${API_BASE%/}"

if ! command -v curl >/dev/null 2>&1; then
  die "curl is required"
fi

permissions=()
case "$ROLE" in
  employee)
    permissions=("attendance:read" "attendance:write")
    ;;
  approver)
    permissions=("attendance:read" "attendance:approve")
    ;;
  admin)
    permissions=("attendance:read" "attendance:write" "attendance:approve" "attendance:admin")
    ;;
  *)
    usage
    die "Invalid ROLE '${ROLE}'. Expected employee|approver|admin."
    ;;
esac

info "Granting permissions: role=${ROLE} userId=${USER_ID} count=${#permissions[@]}"

for perm in "${permissions[@]}"; do
  info "Granting ${perm}"
  curl -fsS \
    -X POST "${API_BASE}/permissions/grant" \
    -H "Authorization: Bearer ${AUTH_TOKEN}" \
    -H "Content-Type: application/json" \
    --data "{\"userId\":\"${USER_ID}\",\"permission\":\"${perm}\"}" \
    >/dev/null
done

info "OK"

