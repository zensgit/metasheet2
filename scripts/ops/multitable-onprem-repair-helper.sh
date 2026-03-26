#!/usr/bin/env bash
set -euo pipefail

function usage() {
  cat <<'EOF'
Usage:
  multitable-onprem-repair-helper.sh set-env --env-file <path> --key <KEY> --value <VALUE>
  multitable-onprem-repair-helper.sh generate-secret --env-file <path> --key <KEY>
  multitable-onprem-repair-helper.sh ensure-dir --dir <path> [--service-user <user>] [--service-group <group>] [--mode <mode>]

Examples:
  multitable-onprem-repair-helper.sh set-env --env-file /opt/metasheet/docker/app.env --key PRODUCT_MODE --value platform
  multitable-onprem-repair-helper.sh generate-secret --env-file /opt/metasheet/docker/app.env --key JWT_SECRET
  multitable-onprem-repair-helper.sh ensure-dir --dir /opt/metasheet/storage/attachments
EOF
}

function die() {
  echo "[multitable-onprem-repair-helper] ERROR: $*" >&2
  exit 1
}

function require_arg_value() {
  local name="$1"
  local value="${2:-}"
  [[ -n "$value" ]] || die "Missing required value for ${name}"
}

function rewrite_env_key() {
  local env_file="$1"
  local key="$2"
  local value="$3"
  python3 - <<'PY' "$env_file" "$key" "$value"
from pathlib import Path
import sys

path = Path(sys.argv[1])
key = sys.argv[2]
value = sys.argv[3]
lines = path.read_text().splitlines() if path.exists() else []

for index, line in enumerate(lines):
    if line.startswith(f"{key}="):
        lines[index] = f"{key}={value}"
        break
else:
    lines.append(f"{key}={value}")

path.write_text("\n".join(lines) + "\n")
PY
}

function run_maybe_sudo() {
  if "$@"; then
    return 0
  fi
  if command -v sudo >/dev/null 2>&1; then
    sudo "$@"
    return 0
  fi
  return 1
}

command="${1:-}"
shift || true

case "$command" in
  set-env)
    env_file=""
    key=""
    value=""
    while [[ "$#" -gt 0 ]]; do
      case "$1" in
        --env-file)
          env_file="${2:-}"
          shift 2
          ;;
        --key)
          key="${2:-}"
          shift 2
          ;;
        --value)
          value="${2:-}"
          shift 2
          ;;
        -h|--help)
          usage
          exit 0
          ;;
        *)
          die "Unknown argument for set-env: $1"
          ;;
      esac
    done
    require_arg_value "--env-file" "$env_file"
    require_arg_value "--key" "$key"
    require_arg_value "--value" "$value"
    rewrite_env_key "$env_file" "$key" "$value"
    grep "^${key}=" "$env_file" || die "Failed to verify ${key} in ${env_file}"
    ;;
  generate-secret)
    env_file=""
    key=""
    while [[ "$#" -gt 0 ]]; do
      case "$1" in
        --env-file)
          env_file="${2:-}"
          shift 2
          ;;
        --key)
          key="${2:-}"
          shift 2
          ;;
        -h|--help)
          usage
          exit 0
          ;;
        *)
          die "Unknown argument for generate-secret: $1"
          ;;
      esac
    done
    require_arg_value "--env-file" "$env_file"
    require_arg_value "--key" "$key"
    secret_value="$(openssl rand -hex 32)"
    rewrite_env_key "$env_file" "$key" "$secret_value"
    grep "^${key}=" "$env_file" || die "Failed to verify ${key} in ${env_file}"
    ;;
  ensure-dir)
    dir_path=""
    service_user="metasheet"
    service_group="metasheet"
    mode="775"
    while [[ "$#" -gt 0 ]]; do
      case "$1" in
        --dir)
          dir_path="${2:-}"
          shift 2
          ;;
        --service-user)
          service_user="${2:-}"
          shift 2
          ;;
        --service-group)
          service_group="${2:-}"
          shift 2
          ;;
        --mode)
          mode="${2:-}"
          shift 2
          ;;
        -h|--help)
          usage
          exit 0
          ;;
        *)
          die "Unknown argument for ensure-dir: $1"
          ;;
      esac
    done
    require_arg_value "--dir" "$dir_path"
    run_maybe_sudo mkdir -p "$dir_path" || die "Failed to create directory ${dir_path}"
    run_maybe_sudo chown "${service_user}:${service_group}" "$dir_path" || die "Failed to chown ${dir_path}"
    run_maybe_sudo chmod "$mode" "$dir_path" || die "Failed to chmod ${dir_path}"
    ls -ld "$dir_path"
    ;;
  -h|--help|"")
    usage
    ;;
  *)
    die "Unknown command: ${command}"
    ;;
esac
