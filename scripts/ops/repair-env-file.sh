#!/usr/bin/env bash
set -euo pipefail

ENV_FILE="${1:-}"
BACKUP_SUFFIX="${BACKUP_SUFFIX:-$(date +%Y%m%dT%H%M%SZ)}"

function die() {
  echo "[repair-env-file] ERROR: $*" >&2
  exit 1
}

[[ -n "${ENV_FILE}" ]] || die "usage: repair-env-file.sh /path/to/env-file"
[[ -f "${ENV_FILE}" ]] || die "env file not found: ${ENV_FILE}"

backup_path="${ENV_FILE}.bak-${BACKUP_SUFFIX}"
cp "${ENV_FILE}" "${backup_path}"

python3 - "${ENV_FILE}" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
text = path.read_text()

if "\\n" in text:
    text = text.replace("\\n", "\n")

lines = [line.rstrip() for line in text.splitlines()]
out: list[str] = []
seen: set[str] = set()

for line in lines:
    if not line:
        continue
    if line.startswith("#") or "=" not in line:
        out.append(line)
        continue

    key = line.split("=", 1)[0]
    if key in seen:
        continue

    seen.add(key)
    out.append(line)

path.write_text("\n".join(out) + "\n")
PY

echo "[repair-env-file] backup=${backup_path}" >&2
echo "[repair-env-file] repaired=${ENV_FILE}" >&2
