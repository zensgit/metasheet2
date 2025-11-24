#!/usr/bin/env bash
# Helper to set environment and run staging validation quickly.
# Usage: source scripts/staging-run-alias.sh

stage_prepare() {
  if [ -z "${STAGING_BASE_URL:-}" ] || [ -z "${API_TOKEN:-}" ]; then
    echo "[stage_prepare] Please export STAGING_BASE_URL and API_TOKEN first." >&2
    echo "Example: export STAGING_BASE_URL=https://staging.example.com" >&2
    echo "         export API_TOKEN=eyJ..." >&2
    return 1
  fi
  echo "[stage_prepare] Ready. Use: stage_run" >&2
}

stage_run() {
  if ! command -v bash >/dev/null 2>&1; then echo "bash not found" >&2; return 2; fi
  if [ -z "${STAGING_BASE_URL:-}" ] || [ -z "${API_TOKEN:-}" ]; then
    echo "[stage_run] Missing STAGING_BASE_URL or API_TOKEN" >&2; return 1; fi
  echo "[stage_run] Preflight health check: $STAGING_BASE_URL/health" >&2
  if ! curl -fsS "$STAGING_BASE_URL/health" >/dev/null 2>&1; then
    echo "[stage_run] Health check FAILED — aborting validation run" >&2
    return 3
  fi
  echo "[stage_run] Health OK — starting staging validation wrapper" >&2
  bash /tmp/execute-staging-validation.sh "$API_TOKEN" "$STAGING_BASE_URL"
}

alias stage_prepare=stage_prepare
alias stage_run=stage_run

echo "[alias] Loaded stage_prepare & stage_run" >&2
