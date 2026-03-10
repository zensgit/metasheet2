#!/usr/bin/env bash
set -euo pipefail

API_BASE="${API_BASE:-}"
AUTH_TOKEN_RAW="${AUTH_TOKEN:-}"
LOGIN_EMAIL="${LOGIN_EMAIL:-}"
LOGIN_PASSWORD="${LOGIN_PASSWORD:-}"
AUTH_RESOLVE_META_FILE="${AUTH_RESOLVE_META_FILE:-}"
AUTH_RESOLVE_ALLOW_INSECURE_HTTP="${AUTH_RESOLVE_ALLOW_INSECURE_HTTP:-}"

LAST_AUTH_CODE=""
LAST_REFRESH_CODE=""
LAST_LOGIN_CODE=""

REFRESH_TOKEN_RESULT=""
LOGIN_TOKEN_RESULT=""

function trim() {
  printf '%s' "${1:-}" | sed -E 's/^[[:space:]]+|[[:space:]]+$//g'
}

function normalize_token() {
  local raw
  raw="$(trim "${1:-}")"
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

function is_truthy() {
  case "${1:-}" in
    1|true|TRUE|yes|YES|on|ON)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

function has_crlf() {
  local value="${1:-}"
  [[ "$value" == *$'\r'* || "$value" == *$'\n'* ]]
}

function is_transient_http_code() {
  case "${1:-}" in
    000|429|500|502|503|504)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

function is_jwt_safe_token_chars() {
  local token="${1:-}"
  [[ "$token" =~ ^[A-Za-z0-9._-]+$ ]]
}

function normalize_and_validate_token() {
  local input
  local normalized
  input="${1:-}"
  if [[ -z "$input" ]]; then
    printf ''
    return 0
  fi
  if has_crlf "$input"; then
    echo "[attendance-resolve-auth] WARN: rejecting token candidate containing CR/LF" >&2
    printf ''
    return 0
  fi
  normalized="$(normalize_token "$input")"
  if [[ -z "$normalized" ]]; then
    printf ''
    return 0
  fi
  if has_crlf "$normalized"; then
    echo "[attendance-resolve-auth] WARN: rejecting token candidate containing CR/LF" >&2
    printf ''
    return 0
  fi
  if ! is_jwt_safe_token_chars "$normalized"; then
    echo "[attendance-resolve-auth] WARN: rejecting token candidate containing non JWT-safe characters" >&2
    printf ''
    return 0
  fi
  printf '%s' "$normalized"
}

function extract_api_host() {
  local value="$1"
  local rest hostport
  rest="${value#*://}"
  hostport="${rest%%/*}"
  if [[ "$hostport" == \[* ]]; then
    printf '%s' "${hostport#\[}" | sed -E 's/\].*$//'
    return 0
  fi
  printf '%s' "${hostport%%:*}"
}

function is_local_http_api_base() {
  local host
  host="$(extract_api_host "$1")"
  case "$host" in
    localhost|127.0.0.1|::1)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

function guard_api_base_security() {
  local value="$1"
  if has_crlf "$value"; then
    echo "[attendance-resolve-auth] ERROR: API_BASE must not contain CR/LF characters" >&2
    return 1
  fi
  case "$value" in
    https://*)
      return 0
      ;;
    http://*)
      if is_local_http_api_base "$value"; then
        return 0
      fi
      if is_truthy "$AUTH_RESOLVE_ALLOW_INSECURE_HTTP"; then
        return 0
      fi
      echo "[attendance-resolve-auth] ERROR: insecure API_BASE '${value}' is not allowed; use https or set AUTH_RESOLVE_ALLOW_INSECURE_HTTP=1" >&2
      return 1
      ;;
    *)
      echo "[attendance-resolve-auth] ERROR: API_BASE must start with https:// or http://" >&2
      return 1
      ;;
  esac
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
  curl -sS -o /dev/null -w '%{http_code}' \
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
    if is_transient_http_code "$code"; then
      sleep "$attempt"
      continue
    fi
    break
  done
  return 1
}

function refresh_token() {
  local token="$1"
  local refresh_json code refreshed payload
  LAST_REFRESH_CODE=""
  REFRESH_TOKEN_RESULT=""
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
    rm -f "$refresh_json"
    return 1
  fi
  refreshed="$(jq -r '.data.token // empty' "$refresh_json")"
  rm -f "$refresh_json"
  REFRESH_TOKEN_RESULT="$(normalize_and_validate_token "$refreshed")"
  if [[ -z "$REFRESH_TOKEN_RESULT" ]]; then
    return 1
  fi
  return 0
}

function login_token() {
  local login_json code token payload
  LAST_LOGIN_CODE=""
  LOGIN_TOKEN_RESULT=""
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
    rm -f "$login_json"
    return 1
  fi
  token="$(jq -r '.data.token // empty' "$login_json")"
  rm -f "$login_json"
  LOGIN_TOKEN_RESULT="$(normalize_and_validate_token "$token")"
  if [[ -z "$LOGIN_TOKEN_RESULT" ]]; then
    return 1
  fi
  return 0
}

function main() {
  if has_crlf "$API_BASE"; then
    echo "[attendance-resolve-auth] ERROR: API_BASE must not contain CR/LF characters" >&2
    return 2
  fi
  API_BASE="$(trim "$API_BASE")"
  API_BASE="${API_BASE%/}"
  if [[ -z "$API_BASE" ]]; then
    echo "[attendance-resolve-auth] ERROR: API_BASE is required" >&2
    return 2
  fi
  guard_api_base_security "$API_BASE" || return 2

  local base_token refreshed_token login_auth_token resolved_token auth_source
  base_token="$(normalize_and_validate_token "$AUTH_TOKEN_RAW")"
  resolved_token=""
  auth_source="none"

  if validate_token_with_retry "$base_token"; then
    resolved_token="$base_token"
    auth_source="token"
  fi

  if [[ -z "$resolved_token" ]]; then
    refreshed_token=""
    if refresh_token "$base_token"; then
      refreshed_token="$REFRESH_TOKEN_RESULT"
    fi
    if validate_token_with_retry "$refreshed_token"; then
      resolved_token="$refreshed_token"
      auth_source="refresh"
    fi
  fi

  if [[ -z "$resolved_token" ]]; then
    login_auth_token=""
    if login_token; then
      login_auth_token="$LOGIN_TOKEN_RESULT"
    fi
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

  # Keep progress under transient infra errors: if /auth/me validation only failed
  # with retriable transport/5xx codes, use the caller-provided token and let
  # downstream scripts continue their own retry logic.
  if [[ -n "$base_token" ]] && is_transient_http_code "${LAST_AUTH_CODE:-}"; then
    write_meta "token_unverified"
    echo "[attendance-resolve-auth] WARN: /auth/me transiently unavailable (last=${LAST_AUTH_CODE}); using provided token without verification" >&2
    printf '%s' "$base_token"
    return 0
  fi

  write_meta "none"
  echo "[attendance-resolve-auth] ERROR: no valid auth token after token/refresh/login fallback" >&2
  return 1
}

main "$@"
