#!/usr/bin/env bash
set -euo pipefail

PACKAGE_FILE="${1:-}"
VERIFY_SHA="${VERIFY_SHA:-1}"
EXTRACT_ROOT="${EXTRACT_ROOT:-}"

function die() {
  echo "[attendance-onprem-package-verify] ERROR: $*" >&2
  exit 1
}

function info() {
  echo "[attendance-onprem-package-verify] $*" >&2
}

function verify_sha() {
  local archive="$1"
  local dir
  local base
  local checksums_abs
  local line
  dir="$(dirname "$archive")"
  base="$(basename "$archive")"
  checksums_abs="$(cd "$dir" && pwd)/SHA256SUMS"
  [[ -f "$checksums_abs" ]] || die "SHA256SUMS not found next to package: ${checksums_abs}"
  line="$(grep " ${base}\$" "$checksums_abs" || true)"
  [[ -n "$line" ]] || die "Checksum entry missing for ${base} in SHA256SUMS"
  if command -v sha256sum >/dev/null 2>&1; then
    (cd "$dir" && printf '%s\n' "$line" | sha256sum -c -)
  elif command -v shasum >/dev/null 2>&1; then
    local expected
    local actual
    expected="$(printf '%s\n' "$line" | awk '{print $1}')"
    actual="$(shasum -a 256 "$archive" | awk '{print $1}')"
    [[ "$expected" == "$actual" ]] || die "Checksum mismatch for ${base}"
  else
    die "Missing checksum tool: sha256sum or shasum"
  fi
}

[[ -n "$PACKAGE_FILE" ]] || die "Usage: scripts/ops/attendance-onprem-package-verify.sh <package.tgz>"
[[ -f "$PACKAGE_FILE" ]] || die "Package not found: ${PACKAGE_FILE}"

if [[ "$VERIFY_SHA" == "1" ]]; then
  verify_sha "$PACKAGE_FILE"
fi

if [[ -z "$EXTRACT_ROOT" ]]; then
  EXTRACT_ROOT="$(mktemp -d)"
  trap 'rm -rf "$EXTRACT_ROOT"' EXIT
else
  mkdir -p "$EXTRACT_ROOT"
fi

tar -xzf "$PACKAGE_FILE" -C "$EXTRACT_ROOT"
pkg_name="$(tar -tzf "$PACKAGE_FILE" | head -n 1 | cut -d/ -f1)"
pkg_root="${EXTRACT_ROOT}/${pkg_name}"

required=(
  "apps/web/dist/index.html"
  "packages/core-backend/dist/src/db/migrate.js"
  "scripts/ops/attendance-onprem-package-install.sh"
  "scripts/ops/attendance-onprem-package-upgrade.sh"
  "docker/app.env.example"
  "ops/nginx/attendance-onprem.conf.example"
  "docs/deployment/attendance-windows-onprem-easy-start-20260306.md"
)

for rel in "${required[@]}"; do
  [[ -e "${pkg_root}/${rel}" ]] || die "Required package content missing: ${rel}"
done

info "Package verify OK"
info "  package: ${PACKAGE_FILE}"
info "  root: ${pkg_root}"
