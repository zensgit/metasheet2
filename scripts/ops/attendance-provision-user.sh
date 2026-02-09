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

function refresh_token_if_needed() {
  # Some environments rotate JWT secrets; a previously issued JWT may become invalid.
  # Use /auth/refresh-token to obtain a fresh JWT before calling admin-only endpoints.
  #
  # IMPORTANT: never print tokens in logs.
  local result code body next
  result="$(curl -sS -w '\n%{http_code}' \
    -X POST "${API_BASE}/auth/refresh-token" \
    -H "Content-Type: application/json" \
    --data "{\"token\":\"${AUTH_TOKEN}\"}" || true)"
  code="${result##*$'\n'}"
  body="${result%$'\n'*}"
  if [[ "$code" != "200" ]]; then
    info "WARN: token refresh failed (HTTP ${code}); using provided token"
    return 0
  fi
  next="$(printf '%s' "$body" | sed -nE 's/.*"token":"([^"]+)".*/\1/p' | head -n 1)"
  if [[ -n "$next" && ${#next} -gt 20 ]]; then
    AUTH_TOKEN="$next"
    info "Token refreshed"
    return 0
  fi
  info "WARN: token refresh response missing token; using provided token"
  return 0
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

refresh_token_if_needed

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
