#!/usr/bin/env bash
set -euo pipefail

echo "Tearing down fallback environment"
if docker ps --format '{{.Names}}' | grep -q '^ms-fallback$'; then
  docker rm -f ms-fallback >/dev/null 2>&1 || true
  echo "Stopped Docker container ms-fallback"
fi
rm -f "$(git rev-parse --show-toplevel 2>/dev/null || pwd)/.env.fallback" || true
echo "Removed .env.fallback"
echo "Fallback teardown complete"
