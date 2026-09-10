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
    --data "$(jq -nc --arg token "$AUTH_TOKEN" '{token: $token}')" 2>/dev/null || true)"
  code="${result##*$'\n'}"
  body="${result%$'\n'*}"
  if [[ "$code" != "200" ]]; then
    info "WARN: token refresh failed (HTTP ${code}); using provided token"
    return 0
  fi
  next="$(jq -r '.data.token // empty' <<<"$body" 2>/dev/null || true)"
  if [[ "$next" =~ ^[A-Za-z0-9._-]+$ && ${#next} -gt 20 ]]; then
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
  - A proven missing route can fall back to legacy grants; missing users/roles cannot.
  - Every successful assignment is independently read back before reporting success.
  - It requires an ADMIN token.
EOF
}

[[ -n "$API_BASE" ]] || { usage; die "API_BASE is required"; }
[[ -n "$AUTH_TOKEN" ]] || { usage; die "AUTH_TOKEN is required"; }
[[ -n "$USER_ID" ]] || { usage; die "USER_ID is required"; }
[[ -n "$ROLE" ]] || { usage; die "ROLE is required"; }

# Normalize API_BASE to not end with "/".
API_BASE="${API_BASE%/}"

command -v curl >/dev/null 2>&1 || die "curl is required"
command -v jq >/dev/null 2>&1 || die "jq is required"
[[ "$AUTH_TOKEN" =~ ^[A-Za-z0-9._-]+$ ]] || die "AUTH_TOKEN_INVALID"
user_path="$(jq -rn --arg id "$USER_ID" '$id | @uri')"

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
    die "ROLE_INVALID"
    ;;
esac

function response_reason() {
  local code
  code="$(jq -r '.error.code // empty' <<<"$HTTP_BODY" 2>/dev/null || true)"
  case "$code" in
    ROLE_NOT_FOUND|NOT_FOUND|USER_TARGET_NOT_FOUND|FEATURE_DISABLED|USER_SCOPE_REQUIRED)
      printf '%s' "$code" ;;
    *) printf 'PROVISION_REQUEST_FAILED' ;;
  esac
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
    --data "${payload}" 2>/dev/null || true)"

  HTTP_CODE="${result##*$'\n'}"
  HTTP_BODY="${result%$'\n'*}"
}

function try_assign_role() {
  info "Assigning attendance role"
  post_json "/admin/users/${user_path}/roles/assign" "$(jq -nc --arg roleId "$role_id" '{roleId: $roleId}')"

  case "${HTTP_CODE}" in
    200|201)
      info "Assigned role ${role_id}"
      return 0
      ;;
    404)
      # Express' absent-route response is distinct from every structured product error.
      if ! jq -e . >/dev/null 2>&1 <<<"$HTTP_BODY" \
        && [[ "$HTTP_BODY" == *"<pre>Cannot POST /api/admin/users/${user_path}/roles/assign</pre>"* ]]; then
        info "ENDPOINT_MISSING: using legacy permission grants"
        return 10
      fi
      ;;
  esac

  info "error: ${HTTP_CODE} $(response_reason)"
  return 1
}

function grant_permissions_legacy() {
  local perm
  info "Granting legacy permissions: count=${#permissions[@]}"
  for perm in "${permissions[@]}"; do
    info "Granting ${perm}"
    post_json "/permissions/grant" "$(jq -nc --arg userId "$USER_ID" --arg permission "$perm" '{userId: $userId, permission: $permission}')"
    case "${HTTP_CODE}" in
      200|201)
        ;;
      *)
        info "error: ${HTTP_CODE} $(response_reason)"
        return 1
        ;;
    esac
  done
  return 0
}

function verify_access() {
  local mode="$1" route result code body expected
  route="/attendance-admin/users/${user_path}/access?scope=global"
  [[ "$mode" != "legacy" ]] || route="/permissions/user/${user_path}"
  result="$(curl -sS -w '\n%{http_code}' --connect-timeout 10 --max-time 30 \
    -H "Authorization: Bearer ${AUTH_TOKEN}" "${API_BASE}${route}" 2>/dev/null || true)"
  code="${result##*$'\n'}"
  body="${result%$'\n'*}"
  [[ "$code" == "200" ]] || die "PROVISION_READBACK_FAILED"
  expected="$(printf '%s\n' "${permissions[@]}" | jq -R . | jq -s .)"
  if ! jq -e --arg mode "$mode" --arg id "$USER_ID" --arg role "$role_id" --argjson expected "$expected" '
    (if $mode == "legacy" then
      select(.userId == $id and .degraded != true)
    else
      select(.ok == true) | .data |
      select(.user.id == $id and (.roles | type == "array" and index($role) != null))
    end) |
    .permissions | select(type == "array") |
    ($expected - . | length == 0)
  ' <<<"$body" >/dev/null 2>&1; then
    die "PROVISION_READBACK_FAILED"
  fi
}

function verify_token_tenant() {
  local expected="${AUTH_EXPECTED_TENANT_ID:-}" result code body
  [[ -n "$expected" ]] || return 0
  result="$(curl -sS -w '\n%{http_code}' --connect-timeout 10 --max-time 30 \
    -H "Authorization: Bearer ${AUTH_TOKEN}" "${API_BASE}/auth/me" 2>/dev/null || true)"
  code="${result##*$'\n'}"
  body="${result%$'\n'*}"
  if [[ "$code" != "200" ]] || ! jq -e --arg expected "$expected" '
    .success == true and (.data.user.tenantId | type == "string")
    and .data.user.tenantId == $expected
  ' <<<"$body" >/dev/null 2>&1; then
    die "PROVISION_TENANT_MISMATCH"
  fi
}

refresh_token_if_needed
verify_token_tenant
status=0
try_assign_role || status=$?
if [[ "${status}" -eq 10 ]]; then
  grant_permissions_legacy
  verify_access legacy
elif [[ "${status}" -ne 0 ]]; then
  exit "${status}"
else
  verify_access modern
fi

info "OK"
