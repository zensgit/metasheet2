#!/bin/bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SSH_USER_HOST="${SSH_USER_HOST:-mainuser@142.171.239.56}"
SSH_KEY="${SSH_KEY:-${HOME}/.ssh/metasheet2_deploy}"
REMOTE_APP_DIR="${REMOTE_APP_DIR:-/home/mainuser/metasheet2}"
REMOTE_CONFIG_FILE="${REMOTE_APP_DIR}/docker/observability/alertmanager/alertmanager.onprem.env"
MODE="${1:-set}"
WEBHOOK_URL="${ALERTMANAGER_WEBHOOK_URL:-}"

ssh_cmd() {
  ssh -i "${SSH_KEY}" -o BatchMode=yes -o StrictHostKeyChecking=no "${SSH_USER_HOST}" "$@"
}

validate_webhook_url() {
  WEBHOOK_URL_INPUT="$1" python3 - <<'EOF'
import os
from urllib.parse import urlparse

url = os.environ["WEBHOOK_URL_INPUT"]
parsed = urlparse(url)
if parsed.scheme not in {"http", "https"} or not parsed.netloc:
    raise SystemExit("ALERTMANAGER_WEBHOOK_URL must be a valid http/https URL")
print(parsed.netloc)
EOF
}

print_status() {
  ssh_cmd "CONFIG_FILE='${REMOTE_CONFIG_FILE}' python3 - <<'EOF'
import os
from pathlib import Path
from urllib.parse import urlparse

path = Path(os.environ['CONFIG_FILE'])
if not path.exists():
    print('configured=false')
    raise SystemExit(0)

content = path.read_text()
url = ''
for line in content.splitlines():
    if line.startswith('ALERTMANAGER_WEBHOOK_URL='):
        url = line.split('=', 1)[1].strip()
        break

if not url:
    print('configured=false')
    raise SystemExit(0)

parsed = urlparse(url)
host = parsed.netloc or 'unknown'
scheme = parsed.scheme or 'unknown'
print('configured=true')
print(f'scheme={scheme}')
print(f'host={host}')
print(f'path_length={len(parsed.path)}')
EOF"
}

clear_config() {
  ssh_cmd "rm -f '${REMOTE_CONFIG_FILE}'"
  echo "[onprem-alertmanager-config] cleared ${REMOTE_CONFIG_FILE}"
}

write_config() {
  local validated_host
  validated_host="$(validate_webhook_url "${WEBHOOK_URL}")"
  local payload_b64
  payload_b64="$(WEBHOOK_URL_INPUT="${WEBHOOK_URL}" python3 - <<'EOF'
import base64
import os

content = "# Managed by scripts/ops/set-dingtalk-onprem-alertmanager-webhook-config.sh\n" \
          f"ALERTMANAGER_WEBHOOK_URL={os.environ['WEBHOOK_URL_INPUT']}\n"
print(base64.b64encode(content.encode()).decode())
EOF
)"

  ssh_cmd "mkdir -p \"$(dirname "${REMOTE_CONFIG_FILE}")\" && tmp_file=\$(mktemp) && printf '%s' '${payload_b64}' | base64 -d > \"\${tmp_file}\" && install -m 600 \"\${tmp_file}\" '${REMOTE_CONFIG_FILE}' && rm -f \"\${tmp_file}\""
  echo "[onprem-alertmanager-config] wrote ${REMOTE_CONFIG_FILE} (host=${validated_host})"
}

case "${MODE}" in
  set)
    if [ -z "${WEBHOOK_URL}" ]; then
      echo "ALERTMANAGER_WEBHOOK_URL is required for set mode" >&2
      exit 1
    fi
    write_config
    ;;
  --clear)
    clear_config
    ;;
  --print-status)
    print_status
    ;;
  *)
    echo "usage: $0 [set|--clear|--print-status]" >&2
    exit 1
    ;;
esac
