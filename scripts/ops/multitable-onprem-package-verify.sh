#!/usr/bin/env bash
set -euo pipefail

PACKAGE_FILE="${1:-}"
VERIFY_SHA="${VERIFY_SHA:-1}"
VERIFY_NO_GITHUB_LINKS="${VERIFY_NO_GITHUB_LINKS:-1}"
EXTRACT_ROOT="${EXTRACT_ROOT:-}"
cleanup_extract_root=0
list_file=""

function die() {
  echo "[multitable-onprem-package-verify] ERROR: $*" >&2
  exit 1
}

function info() {
  echo "[multitable-onprem-package-verify] $*" >&2
}

function collect_delivery_targets() {
  local root="$1"
  local targets=()
  local docs=()

  [[ -f "${root}/INSTALL.txt" ]] && targets+=("${root}/INSTALL.txt")
  if [[ -d "${root}/docs/deployment" ]]; then
    shopt -s nullglob
    docs=("${root}"/docs/deployment/multitable-*.md)
    shopt -u nullglob
    if [[ ${#docs[@]} -gt 0 ]]; then
      targets+=("${docs[@]}")
    fi
  fi

  printf '%s\n' "${targets[@]}"
}

function scan_targets_for_pattern() {
  local description="$1"
  local patterns="$2"
  shift 2
  local targets=("$@")
  local tmp_file

  tmp_file="$(mktemp)"

  if command -v rg >/dev/null 2>&1; then
    if rg -n --ignore-case "$patterns" "${targets[@]}" >"$tmp_file" 2>/dev/null; then
      cat "$tmp_file" >&2 || true
      rm -f "$tmp_file" || true
      die "Found ${description} in on-prem package delivery files"
    fi
  else
    if grep -RInE "$patterns" "${targets[@]}" >"$tmp_file" 2>/dev/null; then
      cat "$tmp_file" >&2 || true
      rm -f "$tmp_file" || true
      die "Found ${description} in on-prem package delivery files"
    fi
  fi

  rm -f "$tmp_file" || true
}

function verify_no_github_links() {
  local root="$1"
  local patterns='github\.com|githubusercontent\.com|github\.io'
  local targets=()

  while IFS= read -r target; do
    [[ -n "$target" ]] && targets+=("$target")
  done < <(collect_delivery_targets "$root")

  if [[ ${#targets[@]} -eq 0 ]]; then
    return 0
  fi

  scan_targets_for_pattern "disallowed GitHub links" "$patterns" "${targets[@]}"
}

function verify_no_absolute_user_paths() {
  local root="$1"
  local patterns='(^|[^[:alnum:]_])(/Users/[^[:space:]]+|/home/[^[:space:]]+)'
  local targets=()

  while IFS= read -r target; do
    [[ -n "$target" ]] && targets+=("$target")
  done < <(collect_delivery_targets "$root")

  if [[ ${#targets[@]} -eq 0 ]]; then
    return 0
  fi

  scan_targets_for_pattern "absolute local user paths" "$patterns" "${targets[@]}"
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

[[ -n "$PACKAGE_FILE" ]] || die "Usage: scripts/ops/multitable-onprem-package-verify.sh <package.tgz|package.zip>"
[[ -f "$PACKAGE_FILE" ]] || die "Package not found: ${PACKAGE_FILE}"

if [[ "$VERIFY_SHA" == "1" ]]; then
  verify_sha "$PACKAGE_FILE"
fi

if [[ -z "$EXTRACT_ROOT" ]]; then
  EXTRACT_ROOT="$(mktemp -d)"
  cleanup_extract_root=1
else
  mkdir -p "$EXTRACT_ROOT"
fi

list_file="$(mktemp)"
cleanup() {
  [[ -n "$list_file" ]] && rm -f "$list_file" || true
  if [[ "$cleanup_extract_root" == "1" ]]; then
    rm -rf "$EXTRACT_ROOT"
  fi
}
trap cleanup EXIT

case "$PACKAGE_FILE" in
  *.tgz|*.tar.gz)
    tar -xzf "$PACKAGE_FILE" -C "$EXTRACT_ROOT"
    tar -tzf "$PACKAGE_FILE" > "$list_file"
    ;;
  *.zip)
    command -v unzip >/dev/null 2>&1 || die "unzip is required to verify zip packages"
    unzip -q "$PACKAGE_FILE" -d "$EXTRACT_ROOT"
    if command -v zipinfo >/dev/null 2>&1; then
      zipinfo -1 "$PACKAGE_FILE" > "$list_file"
    else
      find "$EXTRACT_ROOT" -mindepth 1 -maxdepth 3 -print | sed "s#^${EXTRACT_ROOT}/##" > "$list_file"
    fi
    ;;
  *)
    die "Unsupported package extension (expected .tgz/.tar.gz/.zip): ${PACKAGE_FILE}"
    ;;
esac

pkg_name="$(head -n 1 "$list_file" | cut -d/ -f1)"
pkg_root="${EXTRACT_ROOT}/${pkg_name}"

required=(
  "apps/web/dist/index.html"
  "apps/web/package.json"
  "packages/core-backend/dist/src/index.js"
  "packages/core-backend/dist/src/db/migrate.js"
  "packages/core-backend/package.json"
  "plugins/plugin-attendance/plugin.json"
  "plugins/plugin-attendance/index.cjs"
  "scripts/ops/multitable-onprem-package-install.sh"
  "scripts/ops/multitable-onprem-package-upgrade.sh"
  "scripts/ops/multitable-onprem-deploy-easy.sh"
  "scripts/ops/multitable-onprem-healthcheck.sh"
  "scripts/ops/attendance-wsl-portproxy-refresh.ps1"
  "scripts/ops/attendance-wsl-portproxy-task.ps1"
  "docker/app.env.example"
  "docker/app.env.multitable-onprem.template"
  "ops/nginx/multitable-onprem.conf.example"
  "docs/deployment/multitable-windows-onprem-easy-start-20260319.md"
  "docs/deployment/multitable-onprem-package-layout-20260319.md"
)

for rel in "${required[@]}"; do
  [[ -e "${pkg_root}/${rel}" ]] || die "Required package content missing: ${rel}"
done

if [[ "$VERIFY_NO_GITHUB_LINKS" == "1" ]]; then
  verify_no_github_links "$pkg_root"
  verify_no_absolute_user_paths "$pkg_root"
fi

info "Package verify OK"
info "  package: ${PACKAGE_FILE}"
info "  root: ${pkg_root}"
