#!/usr/bin/env bash
set -euo pipefail

BASE_BRANCH=${1:-main}
NEW_BRANCH=${2:-feat/github-pages-clean}

git fetch origin "$BASE_BRANCH"
git checkout -B "$NEW_BRANCH" "origin/$BASE_BRANCH"

echo "Preparing clean Pages PR branch: $NEW_BRANCH from $BASE_BRANCH"

# Ensure workflow exists
if [ ! -f .github/workflows/publish-openapi-pages.yml ]; then
  echo "publish-openapi-pages.yml not found; ensure it's added before creating PR" >&2
fi

echo "Done. Now push and open PR: gh pr create --base $BASE_BRANCH --head $NEW_BRANCH"

