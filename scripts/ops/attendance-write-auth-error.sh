#!/usr/bin/env bash
set -uo pipefail

META_FILE="${1:-}"
OUTPUT_FILE="${2:-}"
API_BASE="${API_BASE:-}"

function read_meta_value() {
  local key="$1"
  local default_value="$2"
  if [[ -n "$META_FILE" && -f "$META_FILE" ]]; then
    awk -F= -v target="$key" '$1 == target { print $2 }' "$META_FILE" | tail -n1
  else
    printf '%s\n' "$default_value"
  fi
}

function main() {
  if [[ -z "$OUTPUT_FILE" ]]; then
    echo "[attendance-write-auth-error] WARN: OUTPUT_FILE argument is empty" >&2
    return 0
  fi

  local auth_me_last_http refresh_last_http login_last_http login_email_present login_password_present
  auth_me_last_http="$(read_meta_value "AUTH_ME_LAST_HTTP" "unknown")"
  refresh_last_http="$(read_meta_value "AUTH_REFRESH_LAST_HTTP" "unknown")"
  login_last_http="$(read_meta_value "AUTH_LOGIN_LAST_HTTP" "unknown")"
  login_email_present="$(read_meta_value "AUTH_LOGIN_EMAIL_PRESENT" "false")"
  login_password_present="$(read_meta_value "AUTH_LOGIN_PASSWORD_PRESENT" "false")"

  mkdir -p "$(dirname "$OUTPUT_FILE")" || true
  cat > "$OUTPUT_FILE" <<EOF
No valid attendance admin token.
Tried (in order):
1) ATTENDANCE_ADMIN_JWT / vars token via /api/auth/me (retry-aware)
2) /api/auth/refresh-token with JWT token
3) ATTENDANCE_ADMIN_EMAIL + ATTENDANCE_ADMIN_PASSWORD login (secrets or vars)
Diagnostic:
- auth_me_last_http=${auth_me_last_http}
- refresh_last_http=${refresh_last_http}
- login_last_http=${login_last_http}
- login_email_present=${login_email_present}
- login_password_present=${login_password_present}
API_BASE=${API_BASE}
EOF

  return 0
}

main "$@" || true
exit 0
