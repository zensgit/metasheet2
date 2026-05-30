#!/usr/bin/env bash
set -euo pipefail

required="${METRICS_SCRAPE_TOKEN_RESOLVE_REQUIRED:-false}"
deploy_path="${DEPLOY_PATH:-metasheet2}"
deploy_compose_file="${DEPLOY_COMPOSE_FILE:-docker-compose.app.yml}"
token_begin="__METRICS_SCRAPE_TOKEN_BEGIN__"
token_end="__METRICS_SCRAPE_TOKEN_END__"

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

is_required() {
  is_truthy "${required}"
}

warn_or_fail() {
  local message="$1"
  if is_required; then
    echo "::error::${message}" >&2
    exit 1
  fi
  echo "::warning::${message}" >&2
  exit 0
}

validate_single_line_token() {
  local token="$1"
  if [[ -z "${token}" ]]; then
    warn_or_fail "deploy-host METRICS_SCRAPE_TOKEN was empty"
  fi
  if [[ "${token}" == *$'\n'* || "${token}" == *$'\r'* ]]; then
    warn_or_fail "deploy-host METRICS_SCRAPE_TOKEN must be a single-line value"
  fi
}

shell_quote() {
  printf '%q' "$1"
}

tmp_ssh_key=""

cleanup_tmp_key() {
  if [[ -n "${tmp_ssh_key}" && -f "${tmp_ssh_key}" ]]; then
    rm -f "${tmp_ssh_key}"
  fi
}

if [[ -z "${DEPLOY_HOST:-}" || -z "${DEPLOY_USER:-}" || -z "${DEPLOY_SSH_KEY_B64:-}" ]]; then
  warn_or_fail "METRICS_AUTH_HEADER is not set and DEPLOY_HOST/DEPLOY_USER/DEPLOY_SSH_KEY_B64 are incomplete for deploy-host metrics token fallback"
fi

tmp_ssh_key="$(mktemp "${TMPDIR:-/tmp}/metrics-scrape-ssh-key.XXXXXX")"
trap cleanup_tmp_key EXIT
if ! printf '%s' "${DEPLOY_SSH_KEY_B64}" | base64 -d > "${tmp_ssh_key}"; then
  warn_or_fail "failed to decode DEPLOY_SSH_KEY_B64 for deploy-host metrics token fallback"
fi
chmod 600 "${tmp_ssh_key}"

ssh_opts=(-o BatchMode=yes -o ConnectTimeout=15 -o StrictHostKeyChecking=no -o IdentitiesOnly=yes -i "${tmp_ssh_key}")
quoted_deploy_path="$(shell_quote "${deploy_path}")"
quoted_compose_file="$(shell_quote "${deploy_compose_file}")"

set +e
raw_output="$(
  ssh "${ssh_opts[@]}" "${DEPLOY_USER}@${DEPLOY_HOST}" \
    "DEPLOY_PATH=${quoted_deploy_path} DEPLOY_COMPOSE_FILE=${quoted_compose_file} bash -s" <<'EOF'
set -euo pipefail
if [[ "${DEPLOY_PATH}" == /* ]]; then
  DEPLOY_REPO_PATH="${DEPLOY_PATH}"
elif [[ "${DEPLOY_PATH}" == ~/* ]]; then
  DEPLOY_REPO_PATH="${HOME}/${DEPLOY_PATH#~/}"
else
  DEPLOY_REPO_PATH="${HOME}/${DEPLOY_PATH}"
fi
cd "${DEPLOY_REPO_PATH}"

if docker compose version >/dev/null 2>&1; then
  COMPOSE_CMD=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE_CMD=(docker-compose)
else
  echo "docker compose is not available" >&2
  exit 125
fi

token="$("${COMPOSE_CMD[@]}" -f "${DEPLOY_COMPOSE_FILE}" exec -T backend sh -lc 'printf "%s" "${METRICS_SCRAPE_TOKEN:-}"' < /dev/null)"
if [[ -z "${token}" ]]; then
  echo "METRICS_SCRAPE_TOKEN missing from backend runtime env" >&2
  exit 4
fi
if [[ "${token}" == *$'\n'* || "${token}" == *$'\r'* ]]; then
  echo "METRICS_SCRAPE_TOKEN must be a single-line value" >&2
  exit 5
fi

printf '__METRICS_SCRAPE_TOKEN_BEGIN__%s__METRICS_SCRAPE_TOKEN_END__\n' "${token}"
EOF
)"
rc=$?
set -e

token="$(
  printf '%s\n' "${raw_output}" | awk -v begin="${token_begin}" -v end="${token_end}" '
    {
      start = index($0, begin)
      finish = index($0, end)
      if (start > 0 && finish > start) {
        found = substr($0, start + length(begin), finish - start - length(begin))
      }
    }
    END {
      if (found != "") print found
    }
  '
)"

if [[ "${rc}" != "0" || -z "${token}" ]]; then
  warn_or_fail "failed to resolve METRICS_SCRAPE_TOKEN from deploy-host backend runtime"
fi

validate_single_line_token "${token}"
echo "[resolve-metrics-scrape-token] token resolved from deploy-host backend runtime" >&2
printf '%s' "${token}"
