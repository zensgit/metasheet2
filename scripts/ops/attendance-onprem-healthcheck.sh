#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BASE_URL="${BASE_URL:-http://127.0.0.1}"
API_BASE="${API_BASE:-${BASE_URL%/}/api}"
BACKEND_HEALTH_URL="${BACKEND_HEALTH_URL:-http://127.0.0.1:8900/health}"
MAX_TIME="${MAX_TIME:-10}"
SERVICE_MANAGER="${SERVICE_MANAGER:-auto}" # auto|pm2|systemd|none
PM2_APP_NAME="${PM2_APP_NAME:-metasheet-backend}"
SYSTEMD_SERVICE_NAME="${SYSTEMD_SERVICE_NAME:-metasheet-backend.service}"
CHECK_NGINX="${CHECK_NGINX:-1}"
CHECK_METRICS="${CHECK_METRICS:-0}"
METRICS_URL="${METRICS_URL:-http://127.0.0.1:8900/metrics/prom}"
AUTH_TOKEN="${AUTH_TOKEN:-}"
EXPECT_PRODUCT_MODE="${EXPECT_PRODUCT_MODE:-attendance}"

function die() {
  echo "[attendance-onprem-healthcheck] ERROR: $*" >&2
  exit 1
}

function info() {
  echo "[attendance-onprem-healthcheck] $*" >&2
}

function check_url() {
  local url="$1"
  local label="$2"
  info "Checking ${label}: ${url}"
  curl -fsS --max-time "$MAX_TIME" "$url" >/dev/null || die "${label} unreachable: ${url}"
}

function check_service_state_pm2() {
  command -v pm2 >/dev/null 2>&1 || die "pm2 not found but SERVICE_MANAGER=pm2"
  pm2 describe "$PM2_APP_NAME" >/dev/null 2>&1 || die "pm2 app not found: ${PM2_APP_NAME}"
  local pid
  pid="$(pm2 pid "$PM2_APP_NAME" | tail -n 1 | tr -d '[:space:]')"
  [[ -n "$pid" && "$pid" != "0" ]] || die "pm2 app not online: ${PM2_APP_NAME}"
  info "pm2 app online: ${PM2_APP_NAME} (pid=${pid})"
}

function check_service_state_systemd() {
  command -v systemctl >/dev/null 2>&1 || die "systemctl not found but SERVICE_MANAGER=systemd"
  systemctl is-active --quiet "$SYSTEMD_SERVICE_NAME" || die "systemd service not active: ${SYSTEMD_SERVICE_NAME}"
  info "systemd service active: ${SYSTEMD_SERVICE_NAME}"
}

function check_service_state_auto() {
  if command -v pm2 >/dev/null 2>&1 && pm2 describe "$PM2_APP_NAME" >/dev/null 2>&1; then
    check_service_state_pm2
    return 0
  fi
  if command -v systemctl >/dev/null 2>&1; then
    if systemctl list-unit-files "$SYSTEMD_SERVICE_NAME" >/dev/null 2>&1; then
      check_service_state_systemd
      return 0
    fi
  fi
  info "No pm2 app or systemd unit detected; skipping process-manager check (SERVICE_MANAGER=auto)"
}

if ! command -v curl >/dev/null 2>&1; then
  die "curl is required"
fi

case "$SERVICE_MANAGER" in
  auto) check_service_state_auto ;;
  pm2) check_service_state_pm2 ;;
  systemd) check_service_state_systemd ;;
  none) info "Skipping process-manager check (SERVICE_MANAGER=none)" ;;
  *) die "SERVICE_MANAGER must be auto|pm2|systemd|none (got: ${SERVICE_MANAGER})" ;;
esac

if [[ "$CHECK_NGINX" == "1" && "$(command -v systemctl || true)" != "" ]]; then
  if systemctl list-unit-files nginx.service >/dev/null 2>&1; then
    systemctl is-active --quiet nginx || die "nginx service is not active"
    info "nginx service active"
  else
    info "nginx.service not found; skip nginx check"
  fi
fi

check_url "${BACKEND_HEALTH_URL}" "backend health"
check_url "${BASE_URL%/}/" "web root"
check_url "${API_BASE%/}/plugins" "api plugins"

if [[ -n "$AUTH_TOKEN" ]]; then
  info "Checking /api/auth/me feature mode"
  payload="$(curl -fsS --max-time "$MAX_TIME" -H "Authorization: Bearer ${AUTH_TOKEN}" "${API_BASE%/}/auth/me")" || die "GET /api/auth/me failed"
  if command -v node >/dev/null 2>&1; then
    actual_mode="$(
      node -e '
        const raw = process.argv[1] || "{}";
        let parsed = {};
        try { parsed = JSON.parse(raw); } catch {}
        const mode = parsed?.data?.features?.mode || "";
        process.stdout.write(String(mode));
      ' "$payload"
    )"
    if [[ -z "$actual_mode" ]]; then
      die "features.mode missing in /api/auth/me"
    fi
    if [[ "$actual_mode" != "$EXPECT_PRODUCT_MODE" ]]; then
      die "features.mode mismatch: expected=${EXPECT_PRODUCT_MODE}, actual=${actual_mode}"
    fi
    info "features.mode OK: ${actual_mode}"
  else
    info "node not found; skip strict JSON parse for /api/auth/me"
  fi
fi

if [[ "$CHECK_METRICS" == "1" ]]; then
  METRICS_URL="$METRICS_URL" "${ROOT_DIR}/scripts/ops/attendance-check-metrics.sh"
fi

info "Healthcheck OK"
