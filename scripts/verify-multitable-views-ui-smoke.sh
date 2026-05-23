#!/usr/bin/env bash
# Multitable basic-views UI Smoke — grid / calendar / kanban / gallery / form.
#
# Wraps `multitable-basic-views-smoke.spec.ts` so it can run against any
# deployed multitable stack. Pairs with `verify-multitable-rc-ui-smoke.sh`
# (which covers the Gantt view only). Closes the logged-in basic-views UI
# coverage gap recorded in
# docs/development/multitable-issue-1780-closure-verification-20260523.md.
#
# Env contract:
#   FE_BASE_URL    Frontend base, e.g. http://127.0.0.1:18081
#                  (typically an SSH tunnel into staging's :8081)
#   API_BASE_URL   Backend base — usually identical to FE_BASE_URL
#                  when the deployment uses a single nginx in front
#   AUTH_TOKEN     Bearer JWT for an admin-capable user
#   OUTPUT_DIR     Directory for Playwright artifacts (default
#                  output/multitable-views-ui-smoke)
#
# Exit codes:
#   0  5/5 pass
#   1  any test failed
#   2  env / fatal before Playwright ran

set -euo pipefail

require_env() {
  local name="$1"
  if [ -z "${!name:-}" ]; then
    echo "[views-ui-smoke] $name is required" >&2
    exit 2
  fi
}

require_env FE_BASE_URL
require_env API_BASE_URL
require_env AUTH_TOKEN

# Reject URLs that could leak credentials into report files (matches the
# API harness's URL contract — see verify-multitable-rc-staging-smoke.mjs).
reject_unsafe_url() {
  local label="$1" url="$2"
  if echo "$url" | grep -qE '@|\?|#'; then
    echo "[views-ui-smoke] $label must not contain credentials, query, or fragment: $url" >&2
    exit 2
  fi
}

reject_unsafe_url FE_BASE_URL "$FE_BASE_URL"
reject_unsafe_url API_BASE_URL "$API_BASE_URL"

OUTPUT_DIR="${OUTPUT_DIR:-output/multitable-views-ui-smoke}"
mkdir -p "$OUTPUT_DIR"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "[views-ui-smoke] FE_BASE_URL=$FE_BASE_URL"
echo "[views-ui-smoke] API_BASE_URL=$API_BASE_URL"
echo "[views-ui-smoke] OUTPUT_DIR=$OUTPUT_DIR"

# Idempotently ensure Chromium is present. Failure here is non-fatal —
# the Playwright invocation below will surface a usable error if the
# browser is missing.
pnpm --filter @metasheet/core-backend exec playwright install chromium >/dev/null 2>&1 || true

# AUTH_TOKEN is admin-capable. Playwright `--reporter=list` plus any
# trace/console output can echo request headers and the raw token, so
# redact `Authorization: Bearer ...`, bare `Bearer ...`, and the literal
# AUTH_TOKEN value BEFORE any line reaches the terminal or CI logs.
# Stderr is merged with stdout for the sign-off (operators want a single
# pass/fail stream); PIPESTATUS[0] preserves Playwright's exit code so
# the always-zero sed cannot mask a real failure.
# JWT base64url uses [A-Za-z0-9_-] joined by `.`; only `.` is regex-special.
# Bash 3.2-compatible parameter expansion. If AUTH_TOKEN ever takes a non-JWT
# shape with other regex specials, the `Bearer`/`Authorization:` patterns
# above remain the primary defense — this is defense-in-depth.
TOKEN_ESC=${AUTH_TOKEN//./\\.}

EXIT=0
set +e
FE_BASE_URL="$FE_BASE_URL" \
API_BASE_URL="$API_BASE_URL" \
AUTH_TOKEN="$AUTH_TOKEN" \
pnpm --filter @metasheet/core-backend exec playwright test \
  --config tests/e2e/playwright.config.ts \
  multitable-basic-views-smoke.spec.ts \
  --workers=1 \
  --reporter=list \
  2>&1 | sed -E \
    -e 's/([Aa]uthorization:[[:space:]]+[Bb]earer[[:space:]]+)[^[:space:]]+/\1[REDACTED]/g' \
    -e 's/([Bb]earer[[:space:]]+)[^[:space:]]+/\1[REDACTED]/g' \
    -e "s,${TOKEN_ESC},[REDACTED],g"
EXIT=${PIPESTATUS[0]}
set -e

# Copy Playwright artifacts into OUTPUT_DIR for archival. test-results
# only exists on failure under the default config; copy when present.
if [ -d packages/core-backend/test-results ]; then
  cp -R packages/core-backend/test-results "$OUTPUT_DIR/" 2>/dev/null || true
fi

if [ "$EXIT" -eq 0 ]; then
  echo "[views-ui-smoke] PASS — basic views UI 5/5"
else
  echo "[views-ui-smoke] FAIL — exit $EXIT; see $OUTPUT_DIR for trace artifacts"
fi

exit "$EXIT"
