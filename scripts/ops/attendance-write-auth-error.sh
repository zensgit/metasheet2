#!/usr/bin/env bash
set -u

AUTH_RESOLVE_META_FILE_INPUT="${AUTH_RESOLVE_META_FILE:-${1:-}}"
AUTH_ERROR_FILE_INPUT="${AUTH_ERROR_FILE:-${2:-auth-error.txt}}"
API_BASE_VALUE="${API_BASE:-${3:-}}"

auth_source="none"
auth_me_last_http="unknown"
auth_refresh_last_http="unknown"
auth_login_last_http="unknown"
auth_login_email_present="false"
auth_login_password_present="false"

function warn() {
  echo "[attendance-write-auth-error] WARN: $*" >&2
}

function load_meta() {
  local meta_path="$1"
  if [[ ! -f "$meta_path" ]]; then
    warn "auth resolve meta not found: ${meta_path}"
    return 0
  fi

  while IFS='=' read -r key value; do
    [[ -n "${key:-}" ]] || continue
    case "$key" in
      AUTH_SOURCE)
        auth_source="${value:-none}"
        ;;
      AUTH_ME_LAST_HTTP)
        auth_me_last_http="${value:-unknown}"
        ;;
      AUTH_REFRESH_LAST_HTTP)
        auth_refresh_last_http="${value:-unknown}"
        ;;
      AUTH_LOGIN_LAST_HTTP)
        auth_login_last_http="${value:-unknown}"
        ;;
      AUTH_LOGIN_EMAIL_PRESENT)
        auth_login_email_present="${value:-false}"
        ;;
      AUTH_LOGIN_PASSWORD_PRESENT)
        auth_login_password_present="${value:-false}"
        ;;
    esac
  done < "$meta_path"
}

function write_auth_error() {
  local auth_error_file="$1"
  local auth_error_dir
  auth_error_dir="$(dirname "$auth_error_file")"

  if ! mkdir -p "$auth_error_dir" 2>/dev/null; then
    warn "failed to create output directory: ${auth_error_dir}"
  fi

  if ! cat > "$auth_error_file" <<EOF
No valid attendance admin token.
Tried: ATTENDANCE_ADMIN_JWT validation via /api/auth/me, then /api/auth/refresh-token.
Fallback: ATTENDANCE_ADMIN_EMAIL + ATTENDANCE_ADMIN_PASSWORD login.
Remediation:
- Rotate ATTENDANCE_ADMIN_JWT, or
- Configure ATTENDANCE_ADMIN_EMAIL + ATTENDANCE_ADMIN_PASSWORD secrets.
API_BASE=${API_BASE_VALUE}
AUTH_SOURCE=${auth_source}
AUTH_ME_LAST_HTTP=${auth_me_last_http}
AUTH_REFRESH_LAST_HTTP=${auth_refresh_last_http}
AUTH_LOGIN_LAST_HTTP=${auth_login_last_http}
AUTH_LOGIN_EMAIL_PRESENT=${auth_login_email_present}
AUTH_LOGIN_PASSWORD_PRESENT=${auth_login_password_present}
AUTH_RESOLVE_META_FILE=${AUTH_RESOLVE_META_FILE_INPUT:-}
EOF
  then
    warn "failed to write auth error file: ${auth_error_file}"
  fi
}

if [[ -n "${AUTH_RESOLVE_META_FILE_INPUT}" ]]; then
  load_meta "${AUTH_RESOLVE_META_FILE_INPUT}"
else
  warn "AUTH_RESOLVE_META_FILE is empty; using default diagnostics"
fi

write_auth_error "${AUTH_ERROR_FILE_INPUT}"

# Best-effort helper: caller decides whether to fail the workflow.
exit 0
