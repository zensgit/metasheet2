#!/usr/bin/env bash
set -euo pipefail

# Posts a concise 24h approaching reminder to Issue #5.
# Usage: GH_TOKEN must be set (or gh already authenticated).

REPO=zensgit/metasheet2
ISSUE=5
MSG="24h approaching – staging credentials still missing; local validation PASS (17/17, P95 43ms); ready to execute immediately upon receipt."

gh issue comment "$ISSUE" --repo "$REPO" --body "$MSG"
echo "[24h-reminder] posted"

