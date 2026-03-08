#!/usr/bin/env bash
set -euo pipefail

API_BASE="${API_BASE:-}"
AUTH_TOKEN_RAW="${AUTH_TOKEN:-}"
LOGIN_EMAIL="${LOGIN_EMAIL:-}"
LOGIN_PASSWORD="${LOGIN_PASSWORD:-}"
AUTH_RESOLVE_META_FILE="${AUTH_RESOLVE_META_FILE:-}"

LAST_AUTH_CODE=""
LAST_REFRESH_CODE=""
LAST_LOGIN_CODE=""

function trim() {
  printf '%s' "${1:-}" | sed -E 's/^[[:space:]]+|[[:space:]]+$//g'
}

function normalize_token() {
  local raw
  raw="$(printf '%s' "${1:-}" | tr -d '\r\n')"
  raw="$(trim "$raw")"
  raw="${raw#Bearer }"
  raw="${raw#bearer }"
  raw="$(trim "$raw")"
  printf '%s' "$raw"
}

function bool_present() {
  if [[ -n "${1:-}" ]]; then
    echo "true"
  else
    echo "false"
  fi
}

function write_meta() {
  [[ -n "$AUTH_RESOLVE_META_FILE" ]] || return 0
  mkdir -p "$(dirname "$AUTH_RESOLVE_META_FILE")"
  cat > "$AUTH_RESOLVE_META_FILE" <<EOF
AUTH_SOURCE=${1:-none}
AUTH_ME_LAST_HTTP=${LAST_AUTH_CODE:-unknown}
AUTH_REFRESH_LAST_HTTP=${LAST_REFRESH_CODE:-unknown}
AUTH_LOGIN_LAST_HTTP=${LAST_LOGIN_CODE:-unknown}
AUTH_LOGIN_EMAIL_PRESENT=$(bool_present "$LOGIN_EMAIL")
AUTH_LOGIN_PASSWORD_PRESENT=$(bool_present "$LOGIN_PASSWORD")
EOF
}

function request_auth_me_code() {
  local token="$1"
  local out_file
  out_file="$(mktemp)"
  curl -sS -o "$out_file" -w '%{http_code}' \
    --connect-timeout 8 \
    --max-time 20 \
    -H "Authorization: Bearer ${token}" \
    "${API_BASE}/auth/me" || true
}

function validate_token_with_retry() {
  local token="$1"
  local attempt code
  LAST_AUTH_CODE=""
  if [[ -z "$token" ]]; then
    return 1
  fi
  for attempt in 1 2 3; do
    code="$(request_auth_me_code "$token")"
    LAST_AUTH_CODE="$code"
    if [[ "$code" == "200" ]]; then
      return 0
    fi
    case "$code" in
      000|429|500|502|503|504)
        sleep "$attempt"
        ;;
      *)
        break
        ;;
    esac
  done
  return 1
}

function refresh_token() {
  local token="$1"
  local refresh_json code refreshed payload
  LAST_REFRESH_CODE=""
  if [[ -z "$token" ]]; then
    return 1
  fi
  refresh_json="$(mktemp)"
  payload="$(jq -n --arg token "$token" '{ token: $token }')"
  code="$(curl -sS -o "$refresh_json" -w '%{http_code}' \
    --connect-timeout 8 \
    --max-time 20 \
    -X POST "${API_BASE}/auth/refresh-token" \
    -H 'Content-Type: application/json' \
    -d "$payload" || true)"
  LAST_REFRESH_CODE="$code"
  if [[ "$code" != "200" ]]; then
    return 1
  fi
  refreshed="$(jq -r '.data.token // empty' "$refresh_json")"
  refreshed="$(normalize_token "$refreshed")"
  if [[ -z "$refreshed" ]]; then
    return 1
  fi
  printf '%s' "$refreshed"
}

function login_token() {
  local login_json code token payload
  LAST_LOGIN_CODE=""
  if [[ -z "$LOGIN_EMAIL" || -z "$LOGIN_PASSWORD" ]]; then
    return 1
  fi
  login_json="$(mktemp)"
  payload="$(jq -n --arg email "$LOGIN_EMAIL" --arg password "$LOGIN_PASSWORD" '{ email: $email, password: $password }')"
  code="$(curl -sS -o "$login_json" -w '%{http_code}' \
    --connect-timeout 8 \
    --max-time 20 \
    -X POST "${API_BASE}/auth/login" \
    -H 'Content-Type: application/json' \
    -d "$payload" || true)"
  LAST_LOGIN_CODE="$code"
  if [[ "$code" != "200" ]]; then
    return 1
  fi
  token="$(jq -r '.data.token // empty' "$login_json")"
  token="$(normalize_token "$token")"
  if [[ -z "$token" ]]; then
    return 1
  fi
  printf '%s' "$token"
}

function main() {
  API_BASE="$(trim "$API_BASE")"
  API_BASE="${API_BASE%/}"
  if [[ -z "$API_BASE" ]]; then
    echo "[attendance-resolve-auth] ERROR: API_BASE is required" >&2
    return 2
  fi

  local base_token refreshed_token login_auth_token resolved_token auth_source
  base_token="$(normalize_token "$AUTH_TOKEN_RAW")"
  resolved_token=""
  auth_source="none"

  if validate_token_with_retry "$base_token"; then
    resolved_token="$base_token"
    auth_source="token"
  fi

  if [[ -z "$resolved_token" ]]; then
    refreshed_token="$(refresh_token "$base_token" || true)"
    refreshed_token="$(normalize_token "$refreshed_token")"
    if validate_token_with_retry "$refreshed_token"; then
      resolved_token="$refreshed_token"
      auth_source="refresh"
    fi
  fi

  if [[ -z "$resolved_token" ]]; then
    login_auth_token="$(login_token || true)"
    login_auth_token="$(normalize_token "$login_auth_token")"
    if validate_token_with_retry "$login_auth_token"; then
      resolved_token="$login_auth_token"
      auth_source="login"
    fi
  fi

  if [[ -n "$resolved_token" ]]; then
    write_meta "$auth_source"
    printf '%s' "$resolved_token"
    return 0
  fi

  write_meta "none"
  echo "[attendance-resolve-auth] ERROR: no valid auth token after token/refresh/login fallback" >&2
  return 1
}

main "$@"
