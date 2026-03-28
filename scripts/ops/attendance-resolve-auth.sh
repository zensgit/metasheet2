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
  raw="$(printf '%s' "${1:-}" | tr -d '\r\n')"
  raw="$(trim "$raw")"
  raw="${raw#Bearer }"
  raw="${raw#bearer }"
  raw="$(trim "$raw")"
  printf '%s' "$raw"
}

function token_is_safe_for_header() {
  local token="$1"
  [[ "$token" =~ ^[A-Za-z0-9._-]+$ ]]
}

function normalize_safe_token_or_empty() {
  local token
  token="$(normalize_token "${1:-}")"
  if [[ -z "$token" ]]; then
    printf ''
    return 0
  fi
  if ! token_is_safe_for_header "$token"; then
    echo "[attendance-resolve-auth] WARN: token contains unsafe characters; ignoring token candidate" >&2
    printf ''
    return 0
  fi
  printf '%s' "$token"
}

function is_truthy() {
  case "$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')" in
    1|true|yes|on)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

function validate_api_base() {
  local base="$1"
  local lower
  if [[ "$base" == *$'\r'* || "$base" == *$'\n'* ]]; then
    echo "[attendance-resolve-auth] ERROR: API_BASE contains CR/LF characters" >&2
    return 2
  fi
  lower="$(printf '%s' "$base" | tr '[:upper:]' '[:lower:]')"
  if [[ "$lower" =~ ^https:// ]]; then
    return 0
  fi
  if [[ "$lower" =~ ^http://(localhost|127\.0\.0\.1|\[::1\])([/:]|$) ]]; then
    return 0
  fi
  if [[ "$lower" =~ ^http:// ]] && is_truthy "$AUTH_RESOLVE_ALLOW_INSECURE_HTTP"; then
    echo "[attendance-resolve-auth] WARN: API_BASE uses insecure HTTP and is allowed by AUTH_RESOLVE_ALLOW_INSECURE_HTTP" >&2
    return 0
  fi
  if [[ "$lower" =~ ^http:// ]]; then
    echo "[attendance-resolve-auth] ERROR: API_BASE must use HTTPS for non-local hosts (or set AUTH_RESOLVE_ALLOW_INSECURE_HTTP=1 explicitly)" >&2
    return 2
  fi
  echo "[attendance-resolve-auth] ERROR: API_BASE must start with http:// or https://" >&2
  return 2
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
  local out_file code
  if [[ -z "$token" ]]; then
    printf 'invalid-token'
    return 0
  fi
  if ! token_is_safe_for_header "$token"; then
    printf 'invalid-token'
    return 0
  fi
  out_file="$(mktemp)"
  code="$(curl -sS -o "$out_file" -w '%{http_code}' \
    --connect-timeout 8 \
    --max-time 20 \
    -H "Authorization: Bearer ${token}" \
    "${API_BASE}/auth/me" || true)"
  rm -f "$out_file" || true
  printf '%s' "$code"
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
  REFRESH_TOKEN_RESULT=""
  if [[ -z "$token" ]]; then
    return 1
  fi
  if ! token_is_safe_for_header "$token"; then
    LAST_REFRESH_CODE="invalid-token"
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
    rm -f "$refresh_json" || true
    return 1
  fi
  refreshed="$(jq -r '.data.token // empty' "$refresh_json")"
  rm -f "$refresh_json" || true
  refreshed="$(normalize_safe_token_or_empty "$refreshed")"
  if [[ -z "$refreshed" ]]; then
    return 1
  fi
  REFRESH_TOKEN_RESULT="$refreshed"
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
    rm -f "$login_json" || true
    return 1
  fi
  token="$(jq -r '.data.token // empty' "$login_json")"
  rm -f "$login_json" || true
  token="$(normalize_safe_token_or_empty "$token")"
  if [[ -z "$token" ]]; then
    return 1
  fi
  LOGIN_TOKEN_RESULT="$token"
  return 0
}

function main() {
  API_BASE="$(trim "$API_BASE")"
  API_BASE="${API_BASE%/}"
  if [[ -z "$API_BASE" ]]; then
    echo "[attendance-resolve-auth] ERROR: API_BASE is required" >&2
    return 2
  fi
  validate_api_base "$API_BASE" || return $?

  local base_token refreshed_token login_auth_token resolved_token auth_source
  base_token="$(normalize_safe_token_or_empty "$AUTH_TOKEN_RAW")"
  resolved_token=""
  auth_source="none"

  if validate_token_with_retry "$base_token"; then
    resolved_token="$base_token"
    auth_source="token"
  fi

  if [[ -z "$resolved_token" ]]; then
    if refresh_token "$base_token"; then
      refreshed_token="$(normalize_safe_token_or_empty "$REFRESH_TOKEN_RESULT")"
      if validate_token_with_retry "$refreshed_token"; then
        resolved_token="$refreshed_token"
        auth_source="refresh"
      fi
    fi
  fi

  if [[ -z "$resolved_token" ]]; then
    if login_token; then
      login_auth_token="$(normalize_safe_token_or_empty "$LOGIN_TOKEN_RESULT")"
      if validate_token_with_retry "$login_auth_token"; then
        resolved_token="$login_auth_token"
        auth_source="login"
      fi
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
