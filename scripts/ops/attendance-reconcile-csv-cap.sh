#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="${ENV_FILE:-${ROOT_DIR}/docker/app.env}"
COMPOSE_FILE="${COMPOSE_FILE:-${ROOT_DIR}/docker-compose.app.yml}"
NGINX_CONF="${NGINX_CONF:-${ROOT_DIR}/docker/nginx.conf}"
CSV_MAX_ROWS="${CSV_MAX_ROWS:-100000}"
DEPLOY_BCRYPT_SALT_ROUNDS="${DEPLOY_BCRYPT_SALT_ROUNDS:-12}"
RUN_ATTENDANCE_PREFLIGHT="${RUN_ATTENDANCE_PREFLIGHT:-true}"
RESTART_BACKEND="${RESTART_BACKEND:-true}"
ENSURE_METRICS_SCRAPE_TOKEN="${ENSURE_METRICS_SCRAPE_TOKEN:-false}"

is_truthy() {
  case "${1:-}" in
    true|TRUE|True|1|yes|YES|Yes|on|ON|On)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

die() {
  echo "[attendance-env-reconcile] ERROR: $*" >&2
  exit 1
}

if [[ ! "${CSV_MAX_ROWS}" =~ ^[0-9]+$ ]]; then
  die "CSV_MAX_ROWS must be an integer (got: '${CSV_MAX_ROWS}')"
fi
if (( CSV_MAX_ROWS < 1000 )); then
  die "CSV_MAX_ROWS must be >= 1000 (got: ${CSV_MAX_ROWS})"
fi
if [[ ! -f "${ENV_FILE}" ]]; then
  die "missing ${ENV_FILE}"
fi

backup="${ENV_FILE}.bak.$(date -u +%Y%m%d-%H%M%S)"
cp "${ENV_FILE}" "${backup}"
echo "[attendance-env-reconcile] backup=${backup}"

python3 - "${ENV_FILE}" "${CSV_MAX_ROWS}" "${DEPLOY_JWT_SECRET:-}" "${DEPLOY_BCRYPT_SALT_ROUNDS}" "${ENSURE_METRICS_SCRAPE_TOKEN}" "${DEPLOY_METRICS_SCRAPE_TOKEN:-}" <<'PY'
from pathlib import Path
import secrets
import sys

path = Path(sys.argv[1])
csv_max_rows = sys.argv[2]
deploy_jwt_secret = sys.argv[3].strip()
deploy_bcrypt_rounds = sys.argv[4].strip() or "12"
ensure_metrics_token = sys.argv[5].strip().lower() in {"true", "1", "yes", "on"}
deploy_metrics_token = sys.argv[6].strip()

if "\n" in deploy_metrics_token or "\r" in deploy_metrics_token:
    print("[attendance-env-reconcile] ERROR: DEPLOY_METRICS_SCRAPE_TOKEN must be a single-line value", file=sys.stderr)
    sys.exit(4)

text = path.read_text()
if "\\n" in text and text.count("\n") <= 1:
    text = text.replace("\\n", "\n")

lines = text.splitlines()
entries = {}
order = []
for line in lines:
    if "=" in line and not line.lstrip().startswith("#"):
        key, value = line.split("=", 1)
        if key not in entries:
            order.append(key)
        entries[key] = value

jwt_status = "present"
if not entries.get("JWT_SECRET") and deploy_jwt_secret:
    entries["JWT_SECRET"] = deploy_jwt_secret
    jwt_status = "injected"
    if "JWT_SECRET" not in order:
        order.append("JWT_SECRET")
elif not entries.get("JWT_SECRET"):
    entries["JWT_SECRET"] = secrets.token_hex(32)
    jwt_status = "generated and persisted"
    if "JWT_SECRET" not in order:
        order.append("JWT_SECRET")

entries["ATTENDANCE_IMPORT_CSV_MAX_ROWS"] = csv_max_rows
if "ATTENDANCE_IMPORT_CSV_MAX_ROWS" not in order:
    order.append("ATTENDANCE_IMPORT_CSV_MAX_ROWS")

if not entries.get("BCRYPT_SALT_ROUNDS"):
    entries["BCRYPT_SALT_ROUNDS"] = deploy_bcrypt_rounds
    if "BCRYPT_SALT_ROUNDS" not in order:
        order.append("BCRYPT_SALT_ROUNDS")

metrics_status = "skipped"
if ensure_metrics_token:
    if entries.get("METRICS_SCRAPE_TOKEN"):
        metrics_status = "present"
    elif deploy_metrics_token:
        entries["METRICS_SCRAPE_TOKEN"] = deploy_metrics_token
        metrics_status = "injected"
        if "METRICS_SCRAPE_TOKEN" not in order:
            order.append("METRICS_SCRAPE_TOKEN")
    else:
        entries["METRICS_SCRAPE_TOKEN"] = secrets.token_urlsafe(32)
        metrics_status = "generated and persisted"
        if "METRICS_SCRAPE_TOKEN" not in order:
            order.append("METRICS_SCRAPE_TOKEN")

updated = []
seen = set()
for line in lines:
    if "=" in line and not line.lstrip().startswith("#"):
        key = line.split("=", 1)[0]
        if key in seen:
            continue
        seen.add(key)
        updated.append(f"{key}={entries[key]}")
    else:
        updated.append(line)

for key in order:
    if key not in seen:
        updated.append(f"{key}={entries[key]}")

path.write_text("\n".join(updated) + "\n")

verified = {}
for line in path.read_text().splitlines():
    if "=" in line and not line.lstrip().startswith("#"):
        key, value = line.split("=", 1)
        verified[key] = value

current_cap = verified.get("ATTENDANCE_IMPORT_CSV_MAX_ROWS", "")
if current_cap != csv_max_rows:
    print(f"[attendance-env-reconcile] ERROR: expected ATTENDANCE_IMPORT_CSV_MAX_ROWS={csv_max_rows}, got {current_cap or '<missing>'}", file=sys.stderr)
    sys.exit(4)
if not verified.get("JWT_SECRET"):
    print("[attendance-env-reconcile] ERROR: JWT_SECRET is missing after reconcile", file=sys.stderr)
    sys.exit(4)
if not verified.get("BCRYPT_SALT_ROUNDS"):
    print("[attendance-env-reconcile] ERROR: BCRYPT_SALT_ROUNDS is missing after reconcile", file=sys.stderr)
    sys.exit(4)
if ensure_metrics_token:
    metrics_token = verified.get("METRICS_SCRAPE_TOKEN", "")
    if not metrics_token:
        print("[attendance-env-reconcile] ERROR: METRICS_SCRAPE_TOKEN is missing after reconcile", file=sys.stderr)
        sys.exit(4)
    if "\n" in metrics_token or "\r" in metrics_token:
        print("[attendance-env-reconcile] ERROR: METRICS_SCRAPE_TOKEN must be a single-line value", file=sys.stderr)
        sys.exit(4)

print(f"[attendance-env-reconcile] ensured ATTENDANCE_IMPORT_CSV_MAX_ROWS={current_cap}")
print(f"[attendance-env-reconcile] JWT_SECRET {jwt_status}")
print("[attendance-env-reconcile] BCRYPT_SALT_ROUNDS present")
if ensure_metrics_token:
    print(f"[attendance-env-reconcile] METRICS_SCRAPE_TOKEN {metrics_status}")
PY

if is_truthy "${RUN_ATTENDANCE_PREFLIGHT}"; then
  COMPOSE_FILE="${COMPOSE_FILE}" ENV_FILE="${ENV_FILE}" NGINX_CONF="${NGINX_CONF}" \
    "${ROOT_DIR}/scripts/ops/attendance-preflight.sh"
else
  echo "[attendance-env-reconcile] preflight skipped (RUN_ATTENDANCE_PREFLIGHT=${RUN_ATTENDANCE_PREFLIGHT})"
fi

if is_truthy "${RESTART_BACKEND}"; then
  if docker compose version >/dev/null 2>&1; then
    compose_cmd=(docker compose)
  elif command -v docker-compose >/dev/null 2>&1; then
    compose_cmd=(docker-compose)
  else
    die "neither 'docker compose' nor 'docker-compose' is available for backend recreate"
  fi

  echo "[attendance-env-reconcile] recreating backend to apply env"
  "${compose_cmd[@]}" -f "${COMPOSE_FILE}" up -d --no-deps --force-recreate backend
  runtime_cap="$("${compose_cmd[@]}" -f "${COMPOSE_FILE}" exec -T backend sh -lc 'printf "%s" "${ATTENDANCE_IMPORT_CSV_MAX_ROWS:-}"' < /dev/null)"
  if [[ "${runtime_cap}" != "${CSV_MAX_ROWS}" ]]; then
    die "backend runtime ATTENDANCE_IMPORT_CSV_MAX_ROWS mismatch: expected ${CSV_MAX_ROWS}, got ${runtime_cap:-<missing>}"
  fi
  echo "[attendance-env-reconcile] runtime ATTENDANCE_IMPORT_CSV_MAX_ROWS=${runtime_cap}"
  if is_truthy "${ENSURE_METRICS_SCRAPE_TOKEN}"; then
    runtime_metrics_token="$("${compose_cmd[@]}" -f "${COMPOSE_FILE}" exec -T backend sh -lc 'printf "%s" "${METRICS_SCRAPE_TOKEN:-}"' < /dev/null)"
    if [[ -z "${runtime_metrics_token}" ]]; then
      die "backend runtime METRICS_SCRAPE_TOKEN missing after reconcile"
    fi
    if [[ "${runtime_metrics_token}" == *$'\n'* || "${runtime_metrics_token}" == *$'\r'* ]]; then
      die "backend runtime METRICS_SCRAPE_TOKEN must be a single-line value"
    fi
    echo "[attendance-env-reconcile] runtime METRICS_SCRAPE_TOKEN present"
  fi
else
  echo "[attendance-env-reconcile] backend recreate skipped (RESTART_BACKEND=${RESTART_BACKEND})"
fi
