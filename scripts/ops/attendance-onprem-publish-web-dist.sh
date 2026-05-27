#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${ROOT_DIR_OVERRIDE:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
WEB_DIST_SOURCE="${WEB_DIST_SOURCE:-${ROOT_DIR}/apps/web/dist}"
WEB_DIST_TARGET="${WEB_DIST_TARGET:-}"

function info() {
  echo "[attendance-onprem-publish-web-dist] $*" >&2
}

function die() {
  echo "[attendance-onprem-publish-web-dist] ERROR: $*" >&2
  exit 1
}

function resolve_web_dist_target() {
  if [[ -n "$WEB_DIST_TARGET" ]]; then
    printf '%s\n' "$WEB_DIST_TARGET"
    return
  fi

  local normalized="${ROOT_DIR%/}"
  case "$normalized" in
    */packages/*/*)
      local deploy_root="${normalized%%/packages/*}"
      if [[ -n "$deploy_root" && "$deploy_root" != "$normalized" ]]; then
        printf '%s/apps/web/dist\n' "$deploy_root"
        return
      fi
      ;;
    */packages/*)
      local deploy_root="${normalized%%/packages/*}"
      if [[ -n "$deploy_root" && "$deploy_root" != "$normalized" ]]; then
        printf '%s/apps/web/dist\n' "$deploy_root"
        return
      fi
      ;;
  esac

  printf '%s/apps/web/dist\n' "$ROOT_DIR"
}

function same_existing_dir() {
  local left="$1"
  local right="$2"
  [[ -d "$left" && -d "$right" ]] || return 1

  local left_real
  local right_real
  left_real="$(cd "$left" && pwd -P)"
  right_real="$(cd "$right" && pwd -P)"
  [[ "$left_real" == "$right_real" ]]
}

[[ -f "${WEB_DIST_SOURCE}/index.html" ]] || die "Missing web dist source index.html: ${WEB_DIST_SOURCE}/index.html"

target="$(resolve_web_dist_target)"
if same_existing_dir "$WEB_DIST_SOURCE" "$target"; then
  info "Web dist already at nginx root: ${target}"
  exit 0
fi

target_parent="$(dirname "$target")"
mkdir -p "$target_parent"
tmp_target="$(mktemp -d "${target_parent}/.web-dist.tmp.XXXXXX")"

cleanup() {
  rm -rf "$tmp_target" || true
}
trap cleanup EXIT

cp -R "${WEB_DIST_SOURCE}/." "$tmp_target/"
rm -rf "$target"
mv "$tmp_target" "$target"
trap - EXIT

info "Published web dist"
info "  source: ${WEB_DIST_SOURCE}"
info "  target: ${target}"
