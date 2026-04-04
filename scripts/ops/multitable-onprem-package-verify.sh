#!/usr/bin/env bash
set -euo pipefail

PACKAGE_FILE="${1:-}"
VERIFY_SHA="${VERIFY_SHA:-1}"
VERIFY_NO_GITHUB_LINKS="${VERIFY_NO_GITHUB_LINKS:-1}"
EXTRACT_ROOT="${EXTRACT_ROOT:-}"
VERIFY_REPORT_JSON="${VERIFY_REPORT_JSON:-}"
VERIFY_REPORT_MD="${VERIFY_REPORT_MD:-}"
cleanup_extract_root=0
list_file=""
pkg_name=""
pkg_root=""
archive_type="unknown"

function die() {
  echo "[multitable-onprem-package-verify] ERROR: $*" >&2
  exit 1
}

function info() {
  echo "[multitable-onprem-package-verify] $*" >&2
}

function search_fixed_string() {
  local needle="$1"
  shift

  if command -v rg >/dev/null 2>&1; then
    rg --fixed-strings -- "$needle" "$@" >/dev/null 2>&1
    return
  fi

  grep -rIF -- "$needle" "$@" >/dev/null 2>&1
}

function verify_windows_entrypoints() {
  local root="$1"
  local start_script="${root}/deploy.bat"
  local remote_script="${root}/deploy-remote.bat"

  if ! search_fixed_string 'multitable-onprem-apply-package.ps1' "$start_script"; then
    die "deploy.bat must call the PowerShell-native multitable apply helper"
  fi

  if search_fixed_string 'multitable-onprem-apply-package.sh' "$start_script"; then
    die "deploy.bat must not require bash or the .sh apply helper"
  fi

  if ! search_fixed_string 'deploy-remote.log' "$remote_script"; then
    die "deploy-remote.bat must continue writing output\\logs\\deploy-remote.log"
  fi

  if [[ -n "$deploy_run_wrapper" ]] && ! search_fixed_string 'call "%~dp0deploy.bat" "%~1"' "$deploy_run_wrapper"; then
    die "$(basename "$deploy_run_wrapper") must delegate to deploy.bat"
  fi
}

function write_optional_report() {
  local checksum_status="SKIPPED"
  local link_status="SKIPPED"
  local extract_mode="temporary"
  local extract_root_json="null"
  local report_json_tmp=""
  local report_md_tmp=""

  if [[ "$VERIFY_SHA" == "1" ]]; then
    checksum_status="PASS"
  fi
  if [[ "$VERIFY_NO_GITHUB_LINKS" == "1" ]]; then
    link_status="PASS"
  fi
  if [[ "$cleanup_extract_root" == "0" ]]; then
    extract_mode="preserved"
    extract_root_json="\"${pkg_root}\""
  fi

  if [[ -n "$VERIFY_REPORT_JSON" ]]; then
    mkdir -p "$(dirname "$VERIFY_REPORT_JSON")"
    report_json_tmp="${VERIFY_REPORT_JSON}.tmp.$$"
    printf '%s\n' \
      '{' \
      '  "ok": true,' \
      "  \"packageFile\": \"${PACKAGE_FILE}\"," \
      "  \"packageName\": \"${pkg_name}\"," \
      "  \"archiveType\": \"${archive_type}\"," \
      "  \"packageRootInArchive\": \"${pkg_name}\"," \
      "  \"extractMode\": \"${extract_mode}\"," \
      "  \"extractRoot\": ${extract_root_json}," \
      '  "checks": [' \
      '    {' \
      '      "name": "checksum",' \
      "      \"status\": \"${checksum_status}\"" \
      '    },' \
      '    {' \
      '      "name": "required-content",' \
      '      "status": "PASS",' \
      "      \"requiredCount\": ${#required[@]}" \
      '    },' \
      '    {' \
      '      "name": "no-github-links",' \
      "      \"status\": \"${link_status}\"" \
      '    }' \
      '  ],' \
      "  \"generatedAt\": \"$(date -u +"%Y-%m-%dT%H:%M:%SZ")\"" \
      '}' \
      > "$report_json_tmp"
    mv "$report_json_tmp" "$VERIFY_REPORT_JSON"
  fi

  if [[ -n "$VERIFY_REPORT_MD" ]]; then
    mkdir -p "$(dirname "$VERIFY_REPORT_MD")"
    report_md_tmp="${VERIFY_REPORT_MD}.tmp.$$"
    {
      echo "# Multitable On-Prem Package Verify"
      echo
      echo "- Overall: **PASS**"
      echo "- Package: \`${PACKAGE_FILE}\`"
      echo "- Package root in archive: \`${pkg_name}\`"
      echo "- Archive type: \`${archive_type}\`"
      echo "- Extract mode: \`${extract_mode}\`"
      if [[ "$cleanup_extract_root" == "0" ]]; then
        echo "- Extract root: \`${pkg_root}\`"
      fi
      echo
      echo "## Checks"
      echo
      echo "- Checksum: \`${checksum_status}\`"
      echo "- Required content: \`PASS\` (${#required[@]} paths)"
      echo "- No GitHub links in delivery docs: \`${link_status}\`"
    } > "$report_md_tmp"
    mv "$report_md_tmp" "$VERIFY_REPORT_MD"
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
    if rg -n --ignore-case "$patterns" "${targets[@]}" >/tmp/multitable_onprem_link_hits.txt 2>/dev/null; then
      cat /tmp/multitable_onprem_link_hits.txt >&2 || true
      rm -f /tmp/multitable_onprem_link_hits.txt || true
      die "Found disallowed GitHub links in on-prem package delivery files"
    fi
    rm -f /tmp/multitable_onprem_link_hits.txt || true
  else
    if grep -RInE "$patterns" "${targets[@]}" >/tmp/multitable_onprem_link_hits.txt 2>/dev/null; then
      cat /tmp/multitable_onprem_link_hits.txt >&2 || true
      rm -f /tmp/multitable_onprem_link_hits.txt || true
      die "Found disallowed GitHub links in on-prem package delivery files"
    fi
    rm -f /tmp/multitable_onprem_link_hits.txt || true
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
    archive_type="tgz"
    tar -xzf "$PACKAGE_FILE" -C "$EXTRACT_ROOT"
    tar -tzf "$PACKAGE_FILE" > "$list_file"
    ;;
  *.zip)
    archive_type="zip"
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
  "deploy.bat"
  "deploy-remote.bat"
  "plugins/plugin-attendance/plugin.json"
  "plugins/plugin-attendance/index.cjs"
  "scripts/ops/multitable-onprem-apply-package.sh"
  "scripts/ops/multitable-onprem-apply-package.ps1"
  "scripts/ops/multitable-onprem-package-install.sh"
  "scripts/ops/multitable-onprem-package-upgrade.sh"
  "scripts/ops/multitable-onprem-deploy-easy.sh"
  "scripts/ops/multitable-onprem-healthcheck.sh"
  "scripts/ops/attendance-wsl-portproxy-refresh.ps1"
  "scripts/ops/attendance-wsl-portproxy-task.ps1"
  "docker/app.env.example"
  "docker/app.env.multitable-onprem.template"
  "ops/nginx/multitable-onprem.conf.example"
  "docs/deployment/multitable-platform-rc-notes-20260404.md"
  "docs/deployment/multitable-windows-onprem-easy-start-20260319.md"
  "docs/deployment/multitable-onprem-package-layout-20260319.md"
)

for rel in "${required[@]}"; do
  [[ -e "${pkg_root}/${rel}" ]] || die "Required package content missing: ${rel}"
done

deploy_run_wrapper="$(find "$pkg_root" -maxdepth 1 -type f -name 'deploy-*.bat' ! -name 'deploy.bat' ! -name 'deploy-remote.bat' | head -n 1)"
[[ -n "$deploy_run_wrapper" ]] || die "Required package content missing: deploy-<run>.bat"
verify_windows_entrypoints "$pkg_root"

if [[ "$VERIFY_NO_GITHUB_LINKS" == "1" ]]; then
  verify_no_github_links "$pkg_root"
fi

write_optional_report

info "Package verify OK"
info "  package: ${PACKAGE_FILE}"
info "  root: ${pkg_root}"
[[ -n "$VERIFY_REPORT_JSON" ]] && info "  verify_report_json: ${VERIFY_REPORT_JSON}"
[[ -n "$VERIFY_REPORT_MD" ]] && info "  verify_report_md: ${VERIFY_REPORT_MD}"
