#!/usr/bin/env bash
set -euo pipefail

API_BASE="${API_BASE:-}"
AUTH_TOKEN="${AUTH_TOKEN:-}"
USER_ID="${USER_ID:-}"
ROLE="${ROLE:-}"
CURL_RETRY_ATTEMPTS="${CURL_RETRY_ATTEMPTS:-5}"
CURL_RETRY_DELAY_SEC="${CURL_RETRY_DELAY_SEC:-1}"
HTTP_CODE=""
HTTP_BODY=""

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
    --retry "${CURL_RETRY_ATTEMPTS}" \
    --retry-delay "${CURL_RETRY_DELAY_SEC}" \
    --retry-all-errors \
    --connect-timeout 10 \
    --max-time 30 \
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
  - This script prefers POST /api/admin/users/:userId/roles/assign with attendance roles.
  - It falls back to POST /api/permissions/grant for older environments.
  - It requires an ADMIN token.
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
role_id=""
case "$ROLE" in
  employee)
    role_id="attendance_employee"
    permissions=("attendance:read" "attendance:write")
    ;;
  approver)
    role_id="attendance_approver"
    permissions=("attendance:read" "attendance:approve")
    ;;
  admin)
    role_id="attendance_admin"
    permissions=("attendance:read" "attendance:write" "attendance:approve" "attendance:admin")
    ;;
  *)
    usage
    die "Invalid ROLE '${ROLE}'. Expected employee|approver|admin."
    ;;
esac

function compact_body() {
  printf '%s' "${1:-}" | tr '\n' ' ' | sed -E 's/[[:space:]]+/ /g; s/^ //; s/ $//'
}

function post_json() {
  local path="$1"
  local payload="$2"
  local result

  result="$(curl -sS -w '\n%{http_code}' \
    --retry "${CURL_RETRY_ATTEMPTS}" \
    --retry-delay "${CURL_RETRY_DELAY_SEC}" \
    --retry-all-errors \
    --connect-timeout 10 \
    --max-time 30 \
    -X POST "${API_BASE}${path}" \
    -H "Authorization: Bearer ${AUTH_TOKEN}" \
    -H "Content-Type: application/json" \
    --data "${payload}" || true)"

  HTTP_CODE="${result##*$'\n'}"
  HTTP_BODY="${result%$'\n'*}"
}

function try_assign_role() {
  info "Assigning role via admin route: role=${ROLE} roleId=${role_id} userId=${USER_ID}"
  post_json "/admin/users/${USER_ID}/roles/assign" "{\"roleId\":\"${role_id}\"}"

  case "${HTTP_CODE}" in
    200|201)
      info "Assigned role ${role_id}"
      return 0
      ;;
    400)
      if printf '%s' "${HTTP_BODY}" | grep -qE 'ROLE_NOT_FOUND|role not found'; then
        info "WARN: role ${role_id} missing; falling back to legacy permission grants"
        return 10
      fi
      ;;
    404)
      info "WARN: admin role assignment endpoint missing; falling back to legacy permission grants"
      return 10
      ;;
  esac

  info "error: ${HTTP_CODE} $(compact_body "${HTTP_BODY}")"
  return 1
}

function grant_permissions_legacy() {
  local perm
  info "Granting permissions via legacy route: role=${ROLE} userId=${USER_ID} count=${#permissions[@]}"
  for perm in "${permissions[@]}"; do
    info "Granting ${perm}"
    post_json "/permissions/grant" "{\"userId\":\"${USER_ID}\",\"permission\":\"${perm}\"}"
    case "${HTTP_CODE}" in
      200|201)
        ;;
      *)
        info "error: ${HTTP_CODE} $(compact_body "${HTTP_BODY}")"
        return 1
        ;;
    esac
  done
  return 0
}

status=0
try_assign_role || status=$?
if [[ "${status}" -eq 10 ]]; then
  grant_permissions_legacy
elif [[ "${status}" -ne 0 ]]; then
  exit "${status}"
fi

info "OK"
