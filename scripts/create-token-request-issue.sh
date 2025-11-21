#!/usr/bin/env bash
set -euo pipefail

# Creates a GitHub Issue to request a short-lived Staging JWT token.
# Requirements:
#   - GH_TOKEN env set (with repo:issues scope)
#   - GH_REPO env set as owner/repo (optional if git remote origin is available)

if [[ -z "${GH_TOKEN:-}" ]]; then
  echo "❌ GH_TOKEN is required (repo:issues scope)" >&2; exit 2;
fi

if [[ -z "${GH_REPO:-}" ]]; then
  if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    origin=$(git remote get-url origin 2>/dev/null || echo "")
    if [[ "$origin" =~ github.com[:/](.+)/(.+)\.git$ ]]; then
      owner="${BASH_REMATCH[1]}"; repo="${BASH_REMATCH[2]}";
      GH_REPO="$owner/$repo"
    else
      echo "❌ GH_REPO not set and could not parse git origin" >&2; exit 2
    fi
  else
    echo "❌ GH_REPO not set and not a git repo" >&2; exit 2
  fi
fi

TITLE="Request Staging JWT Token — Sprint 2 Validation ($(date +%Y-%m-%d))"
BODY_FILE="docs/sprint2/REQUEST_STAGING_TOKEN.md"
if [[ ! -f "$BODY_FILE" ]]; then
  echo "❌ Missing $BODY_FILE" >&2; exit 2
fi

# JSON-escape body using Python for portability
BODY_JSON=$(python3 - << 'PY'
import json,sys
path='docs/sprint2/REQUEST_STAGING_TOKEN.md'
with open(path,'r',encoding='utf-8') as f:
    print(json.dumps(f.read()))
PY
)

labels=${LABELS:-'["staging","token","sprint2"]'}
assignees=${ASSIGNEES:-'[]'}

payload=$(cat <<EOF
{
  "title": "$TITLE",
  "body": $BODY_JSON,
  "labels": $labels,
  "assignees": $assignees
}
EOF
)

echo "Creating issue in $GH_REPO ..."
resp=$(curl -sS -X POST \
  -H "Authorization: token $GH_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  -d "$payload" \
  "https://api.github.com/repos/$GH_REPO/issues")

url=$(echo "$resp" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("html_url",""))')
number=$(echo "$resp" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("number",""))')

if [[ -z "$url" ]]; then
  echo "❌ Failed to create issue. Response:" >&2
  echo "$resp" >&2
  exit 1
fi

echo "✅ Issue created: #$number $url"

