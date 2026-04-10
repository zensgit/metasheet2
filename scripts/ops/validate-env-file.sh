#!/usr/bin/env bash
set -euo pipefail

ENV_FILE="${1:-}"

function die() {
  echo "[validate-env-file] ERROR: $*" >&2
  exit 1
}

[[ -n "${ENV_FILE}" ]] || die "usage: validate-env-file.sh /path/to/env-file"
[[ -f "${ENV_FILE}" ]] || die "env file not found: ${ENV_FILE}"

line_count="$(wc -l < "${ENV_FILE}" | tr -d ' ')"
key_count="$(grep -Ec '^[A-Za-z_][A-Za-z0-9_]*=' "${ENV_FILE}" || true)"

if grep -qF '\n' "${ENV_FILE}" && [[ "${line_count}" -le 2 ]]; then
  die "${ENV_FILE} contains literal '\\n' sequences and only ${line_count} line(s). Rewrite it with real newlines before running Docker Compose."
fi

if [[ "${key_count}" -eq 0 ]]; then
  die "${ENV_FILE} does not contain any KEY=VALUE lines."
fi

echo "[validate-env-file] OK: ${ENV_FILE}" >&2
