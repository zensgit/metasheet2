#!/usr/bin/env bash
set -euo pipefail

# Secret scan before PR ready.
# - Ignores common noise dirs (node_modules, claudedocs, docs)
# - Distinguishes error vs info severity to reduce false positives

echo "[secret-scan] scanning repo..." >&2

issues=0
infos=0

# Default excludes; override via EXCLUDE_PATHS (space-separated git pathspecs)
EXCLUDE_PATHS=${EXCLUDE_PATHS:-":!node_modules" ":!**/node_modules/**" ":!claudedocs" ":!**/claudedocs/**" ":!docs" ":!**/docs/**" ":!.env.example" ":!**/*.example"}

git_grep() {
  # shellcheck disable=SC2068
  git grep -I -n -E "$1" -- $EXCLUDE_PATHS 2>/dev/null || true
}

report() {
  local sev="$1"; local label="$2"; shift 2; local matches="$*"
  if [[ -n "$matches" ]]; then
    if [[ "$sev" == "error" ]]; then
      echo "[ERROR] $label" >&2
      echo "$matches"
      issues=$((issues+1))
    else
      echo "[INFO]  $label" >&2
      echo "$matches" | sed -n '1,10p'  # cap info output
      infos=$((infos+1))
    fi
  fi
}

# 1) Clear indicators of embedded private material (fail)
report error "Private key block" "$(git_grep '-----BEGIN (PRIVATE|RSA|EC) KEY-----')"
report error "JWT full token pattern" "$(git_grep '[A-Za-z0-9_]{32,}\.[A-Za-z0-9_]{32,}\.[A-Za-z0-9_\-]{32,}')"
report error "AWS access key pattern" "$(git_grep '(AKIA|ASIA)[A-Z0-9]{16}')"

# 2) Likely examples/snippets (info)
report info  "Possible JWT fragment" "$(git_grep 'eyJ[a-zA-Z0-9_=-]{20,}')"

# 3) JWT_SECRET assignment with non-trivial value outside examples (fail)
report error "JWT_SECRET assigned a value" "$(git_grep 'JWT_SECRET\s*[:=]\s*[^\s\"]{12,}')"

if [ $issues -eq 0 ]; then
  echo "[secret-scan] No error-level secret patterns found. ($infos info signals)" >&2
else
  echo "[secret-scan] Issues detected: $issues (review required). Infos: $infos" >&2
  exit 2
fi
