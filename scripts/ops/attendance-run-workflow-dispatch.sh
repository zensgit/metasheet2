#!/usr/bin/env bash
set -euo pipefail

WORKFLOW="${WORKFLOW:-}"
if [[ $# -gt 0 && "${1:-}" != *=* ]]; then
  WORKFLOW="$1"
  shift || true
fi

BRANCH="${BRANCH:-main}"
REF="${REF:-}"
EVENT_NAME="${EVENT_NAME:-workflow_dispatch}"
TIMEOUT_SECONDS="${TIMEOUT_SECONDS:-900}"
POLL_SECONDS="${POLL_SECONDS:-5}"
LOOKBACK_LIMIT="${LOOKBACK_LIMIT:-40}"
DOWNLOAD_DIR="${DOWNLOAD_DIR:-}"

function die() {
  echo "[attendance-run-workflow-dispatch] ERROR: $*" >&2
  exit 1
}

function info() {
  echo "[attendance-run-workflow-dispatch] $*" >&2
}

function warn() {
  echo "[attendance-run-workflow-dispatch] WARN: $*" >&2
}

command -v gh >/dev/null 2>&1 || die "gh is required"
command -v jq >/dev/null 2>&1 || die "jq is required"

[[ -n "$WORKFLOW" ]] || die "workflow file/name is required (example: attendance-daily-gate-dashboard.yml)"
[[ "$TIMEOUT_SECONDS" =~ ^[0-9]+$ ]] || die "TIMEOUT_SECONDS must be integer"
[[ "$POLL_SECONDS" =~ ^[0-9]+$ ]] || die "POLL_SECONDS must be integer"
[[ "$LOOKBACK_LIMIT" =~ ^[0-9]+$ ]] || die "LOOKBACK_LIMIT must be integer"

dispatch_args=()
for token in "$@"; do
  if [[ "$token" != *=* ]]; then
    die "invalid dispatch token '$token' (expected key=value)"
  fi
  key="${token%%=*}"
  value="${token#*=}"
  dispatch_args+=("-f" "${key}=${value}")
  if [[ "$key" == "branch" && -n "$value" ]]; then
    BRANCH="$value"
  fi
done

started_at_iso="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
started_at_epoch="$(date +%s)"
deadline_epoch=$((started_at_epoch + TIMEOUT_SECONDS))

info "workflow=${WORKFLOW} branch=${BRANCH} event=${EVENT_NAME} timeout=${TIMEOUT_SECONDS}s poll=${POLL_SECONDS}s"
if (( ${#dispatch_args[@]} > 0 )); then
  info "dispatch_args=${dispatch_args[*]}"
fi

workflow_run_args=()
if [[ -n "$REF" ]]; then
  workflow_run_args+=("--ref" "$REF")
  if [[ "$BRANCH" == "main" ]]; then
    BRANCH="$REF"
  fi
fi

gh workflow run "$WORKFLOW" "${workflow_run_args[@]}" "${dispatch_args[@]}"

run_id=""
run_url=""
while :; do
  now_epoch="$(date +%s)"
  if (( now_epoch >= deadline_epoch )); then
    die "timed out waiting for dispatched run to appear for workflow=${WORKFLOW} branch=${BRANCH}"
  fi

  list_json="$(gh run list \
    --workflow "$WORKFLOW" \
    --branch "$BRANCH" \
    --limit "$LOOKBACK_LIMIT" \
    --json databaseId,createdAt,event,headBranch,url,name,status 2>/dev/null || true)"

  if [[ -n "$list_json" && "$list_json" != "[]" ]]; then
    run_id="$(printf '%s\n' "$list_json" | jq -r \
      --arg started "$started_at_iso" \
      --arg event "$EVENT_NAME" \
      --arg branch "$BRANCH" \
      '
      [
        .[]
        | select((.event // "") == $event)
        | select((.headBranch // "") == $branch)
        | select((.createdAt // "") >= $started)
      ]
      | sort_by(.createdAt)
      | last
      | .databaseId // empty
      ')"
    run_url="$(printf '%s\n' "$list_json" | jq -r \
      --arg started "$started_at_iso" \
      --arg event "$EVENT_NAME" \
      --arg branch "$BRANCH" \
      '
      [
        .[]
        | select((.event // "") == $event)
        | select((.headBranch // "") == $branch)
        | select((.createdAt // "") >= $started)
      ]
      | sort_by(.createdAt)
      | last
      | .url // empty
      ')"
  fi

  if [[ -n "$run_id" ]]; then
    break
  fi
  sleep "$POLL_SECONDS"
done

info "run_id=${run_id}"
if [[ -n "$run_url" ]]; then
  info "run_url=${run_url}"
fi

gh run watch "$run_id" --exit-status

if [[ -n "$DOWNLOAD_DIR" ]]; then
  artifact_dir="${DOWNLOAD_DIR%/}/${run_id}"
  mkdir -p "$artifact_dir"
  if ! gh run download "$run_id" -D "$artifact_dir"; then
    warn "artifact download failed for run_id=${run_id}"
  else
    info "artifacts downloaded: ${artifact_dir}"
  fi
fi

echo "RUN_ID=${run_id}"
