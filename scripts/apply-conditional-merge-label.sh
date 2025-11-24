#!/usr/bin/env bash
set -euo pipefail

# Adds a conditional merge label to the current PR (requires gh CLI auth).
# Usage: ./scripts/apply-conditional-merge-label.sh <pr-number> [label]

PR=${1:-}
LABEL=${2:-"Local Validation Only"}
REPO="zensgit/metasheet2"

if [ -z "$PR" ]; then
  echo "Usage: $0 <pr-number> [label]" >&2; exit 1; fi

echo "[conditional-label] Applying label '$LABEL' to PR #$PR" >&2
gh pr edit "$PR" --repo "$REPO" --add-label "$LABEL"
echo "[conditional-label] Done" >&2

