#!/usr/bin/env bash
set -euo pipefail

NODE_VERSION="${NODE_VERSION:-v20.20.2}"
PNPM_VERSION="${PNPM_VERSION:-10.33.0}"
ARCH="${ARCH:-linux-x64}"
ARCHIVE="node-${NODE_VERSION}-${ARCH}.tar.xz"
BASE_URL="https://nodejs.org/dist/${NODE_VERSION}"
INSTALL_ROOT="${HOME}/.local/lib/node-${NODE_VERSION}-${ARCH}"
CURRENT_LINK="${HOME}/.local/lib/node-current"
BIN_DIR="${HOME}/.local/bin"
TMP_DIR="${HOME}/.local/tmp"
COREPACK_HOME_DIR="${HOME}/.local/share/corepack"
PATH_GUARD='case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) export PATH="$HOME/.local/bin:$PATH" ;; esac'

mkdir -p "${BIN_DIR}" "${TMP_DIR}" "${HOME}/.local/lib" "${COREPACK_HOME_DIR}"

if [ ! -x "${INSTALL_ROOT}/bin/node" ]; then
  curl -fsSL "${BASE_URL}/${ARCHIVE}" -o "${TMP_DIR}/${ARCHIVE}"
  rm -rf "${INSTALL_ROOT}"
  tar -xJf "${TMP_DIR}/${ARCHIVE}" -C "${HOME}/.local/lib"
fi

ln -sfn "${INSTALL_ROOT}" "${CURRENT_LINK}"
ln -sfn "${CURRENT_LINK}/bin/node" "${BIN_DIR}/node"
ln -sfn "${CURRENT_LINK}/bin/npm" "${BIN_DIR}/npm"
ln -sfn "${CURRENT_LINK}/bin/npx" "${BIN_DIR}/npx"
ln -sfn "${CURRENT_LINK}/bin/corepack" "${BIN_DIR}/corepack"

export PATH="${HOME}/.local/bin:${PATH}"
hash -r

append_path_guard() {
  local target_file="$1"
  touch "${target_file}"
  if grep -Fq "${PATH_GUARD}" "${target_file}"; then
    return
  fi

  # Remove the earlier unconditional export we used during one-off repair work.
  python3 - "${target_file}" <<'PY'
from pathlib import Path
import sys

target = Path(sys.argv[1])
line = 'export PATH="$HOME/.local/bin:$PATH"'
content = target.read_text() if target.exists() else ''
lines = [entry for entry in content.splitlines() if entry.strip() != line]
target.write_text('\n'.join(lines).rstrip() + '\n')
PY

  printf '\n%s\n' "${PATH_GUARD}" >> "${target_file}"
}

append_path_guard "${HOME}/.profile"
append_path_guard "${HOME}/.bashrc"

COREPACK_HOME="${COREPACK_HOME_DIR}" "${BIN_DIR}/corepack" enable --install-directory "${BIN_DIR}"
COREPACK_HOME="${COREPACK_HOME_DIR}" "${BIN_DIR}/corepack" prepare "pnpm@${PNPM_VERSION}" --activate

echo "node=$(node -v)"
echo "pnpm=$(pnpm -v)"
echo "corepack=$(corepack --version)"
