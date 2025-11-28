#!/usr/bin/env bash
set -euo pipefail

# Simple release tag helper for v2.5.0 (or provided VERSION env)
# Usage:
#   VERSION=v2.5.0 bash scripts/release-tag.sh
#   bash scripts/release-tag.sh  # defaults to version from package.json

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

PKG_VERSION=$(node -p "require('./package.json').version" 2>/dev/null || echo "")
VERSION="${1:-v${PKG_VERSION}}"

if [[ -z "$PKG_VERSION" ]]; then
  echo "[release] Could not read package.json version; provide VERSION arg (e.g. v2.5.0)" >&2
  exit 1
fi

if [[ ! "$VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+ ]]; then
  echo "[release] VERSION must look like vX.Y.Z (got: $VERSION)" >&2
  exit 1
fi

echo "[release] Tagging ${VERSION} (package.json=${PKG_VERSION})" >&2

git tag -a "$VERSION" -m "Release $VERSION: Phase 5 Operationalization"
git push origin "$VERSION"

echo "[release] Done."

