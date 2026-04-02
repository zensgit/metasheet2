#!/usr/bin/env bash
set -euo pipefail

PACKAGE_FILE="${1:-}"
VERIFY_SHA="${VERIFY_SHA:-1}"
VERIFY_NO_GITHUB_LINKS="${VERIFY_NO_GITHUB_LINKS:-1}"
EXTRACT_ROOT="${EXTRACT_ROOT:-}"
cleanup_extract_root=0
list_file=""

function die() {
  echo "[attendance-onprem-package-verify] ERROR: $*" >&2
  exit 1
}

function info() {
  echo "[attendance-onprem-package-verify] $*" >&2
}

function verify_windows_entrypoints() {
  local root="$1"
  local start_script="${root}/start-pm2.bat"
  local deploy_script="${root}/deploy-${run_label}.bat"

  if ! rg -n --fixed-strings -- '-RootDir "%~dp0."' "$start_script" >/dev/null 2>&1; then
    die "start-pm2.bat must pass -RootDir \"%~dp0.\" to avoid Windows path quoting bugs"
  fi

  if [[ -n "$run_label" ]] && [[ -f "$deploy_script" ]]; then
    if ! rg -n --fixed-strings -- '-RootDir "%~dp0."' "$deploy_script" >/dev/null 2>&1; then
      die "deploy-${run_label}.bat must pass -RootDir \"%~dp0.\" to avoid Windows path quoting bugs"
    fi
  fi
}

function verify_no_github_links() {
  local root="$1"
  local patterns='github\.com|githubusercontent\.com|github\.io'
  local targets=()

  [[ -f "${root}/INSTALL.txt" ]] && targets+=("${root}/INSTALL.txt")
  [[ -d "${root}/docs/deployment" ]] && targets+=("${root}/docs/deployment")

  if [[ ${#targets[@]} -eq 0 ]]; then
    return 0
  fi

  if command -v rg >/dev/null 2>&1; then
    if rg -n --ignore-case "$patterns" "${targets[@]}" >/tmp/attendance_onprem_link_hits.txt 2>/dev/null; then
      cat /tmp/attendance_onprem_link_hits.txt >&2 || true
      rm -f /tmp/attendance_onprem_link_hits.txt || true
      die "Found disallowed GitHub links in on-prem package delivery files"
    fi
    rm -f /tmp/attendance_onprem_link_hits.txt || true
  else
    if grep -RInE "$patterns" "${targets[@]}" >/tmp/attendance_onprem_link_hits.txt 2>/dev/null; then
      cat /tmp/attendance_onprem_link_hits.txt >&2 || true
      rm -f /tmp/attendance_onprem_link_hits.txt || true
      die "Found disallowed GitHub links in on-prem package delivery files"
    fi
    rm -f /tmp/attendance_onprem_link_hits.txt || true
  fi
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

[[ -n "$PACKAGE_FILE" ]] || die "Usage: scripts/ops/attendance-onprem-package-verify.sh <package.tgz|package.zip>"
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
run_label="$(printf '%s' "$pkg_name" | sed -nE 's/^.*-(run[0-9]+)(-.+)?$/\1/p')"

required=(
  "start-pm2.bat"
  "start-pm2-remote.bat"
  "apps/web/dist/index.html"
  "apps/web/package.json"
  "packages/core-backend/dist/src/index.js"
  "packages/core-backend/dist/src/db/migrate.js"
  "packages/core-backend/package.json"
  "plugins/plugin-attendance/plugin.json"
  "plugins/plugin-attendance/index.cjs"
  "scripts/ops/attendance-onprem-start-pm2.ps1"
  "scripts/ops/attendance-onprem-deploy-run.ps1"
  "scripts/ops/attendance-onprem-package-install.sh"
  "scripts/ops/attendance-onprem-package-upgrade.sh"
  "run-migrate.bat"
  "scripts/ops/attendance-wsl-portproxy-refresh.ps1"
  "scripts/ops/attendance-wsl-portproxy-task.ps1"
  "docker/app.env.example"
  "docker/app.env.attendance-onprem.template"
  "docker/app.env.attendance-onprem.ready.env"
  "ops/nginx/attendance-onprem.conf.example"
  "docs/deployment/attendance-windows-onprem-easy-start-20260306.md"
  "docs/deployment/attendance-windows-wsl-onprem-20260306.md"
  "docs/deployment/attendance-windows-wsl-direct-commands-20260306.md"
  "docs/deployment/attendance-windows-wsl-customer-profiled-commands-20260306.md"
)

for rel in "${required[@]}"; do
  [[ -e "${pkg_root}/${rel}" ]] || die "Required package content missing: ${rel}"
done

if [[ -n "$run_label" ]]; then
  [[ -e "${pkg_root}/deploy-${run_label}.bat" ]] || die "Required package content missing: deploy-${run_label}.bat"
fi

verify_windows_entrypoints "$pkg_root"

if [[ -d "${pkg_root}/plugins" ]]; then
  extra_plugins="$({
    find "${pkg_root}/plugins" -mindepth 1 -maxdepth 1 -type d -exec basename {} \;
  } | grep -v '^plugin-attendance$' || true)"
  if [[ -n "$extra_plugins" ]]; then
    echo "$extra_plugins" >&2
    die "Attendance on-prem package must only include plugin-attendance under plugins/"
  fi
fi

if [[ "$VERIFY_NO_GITHUB_LINKS" == "1" ]]; then
  verify_no_github_links "$pkg_root"
fi

if rg -n 'VITE_API_(URL|BASE):"http://(127\.0\.0\.1|localhost)' "${pkg_root}/apps/web/dist" >/dev/null 2>&1; then
  die "Frontend bundle embeds loopback VITE_API_* config; rebuild package with isolated web env"
fi

info "Package verify OK"
info "  package: ${PACKAGE_FILE}"
info "  root: ${pkg_root}"
