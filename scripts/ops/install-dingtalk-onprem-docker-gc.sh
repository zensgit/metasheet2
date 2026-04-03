#!/bin/bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SSH_USER_HOST="${SSH_USER_HOST:-mainuser@142.171.239.56}"
SSH_KEY="${SSH_KEY:-${HOME}/.ssh/metasheet2_deploy}"
REMOTE_BIN_DIR="${REMOTE_BIN_DIR:-/home/mainuser/bin}"
REMOTE_SCRIPT_PATH="${REMOTE_BIN_DIR}/dingtalk-onprem-docker-gc.sh"
REMOTE_LOG_DIR="${REMOTE_LOG_DIR:-/home/mainuser/docker-gc-runs}"
GC_SCHEDULE_CRON="${GC_SCHEDULE_CRON:-17 4 * * *}"
MODE="${1:-install}"

ssh_cmd() {
  ssh -i "${SSH_KEY}" -o BatchMode=yes -o StrictHostKeyChecking=no "${SSH_USER_HOST}" "$@"
}

print_status() {
  ssh_cmd "REMOTE_SCRIPT_PATH='${REMOTE_SCRIPT_PATH}' REMOTE_LOG_DIR='${REMOTE_LOG_DIR}' GC_SCHEDULE_CRON='${GC_SCHEDULE_CRON}' python3 - <<'EOF'
import os
import subprocess
from pathlib import Path

script_path = Path(os.environ['REMOTE_SCRIPT_PATH'])
log_dir = Path(os.environ['REMOTE_LOG_DIR'])
cron_schedule = os.environ['GC_SCHEDULE_CRON']
cron_line = f\"{cron_schedule} REMOTE_SELF=true {script_path} >> {log_dir}/cron.log 2>&1\"
current = subprocess.run(['crontab', '-l'], capture_output=True, text=True)
entries = current.stdout.splitlines() if current.returncode == 0 else []
present = any(str(script_path) in line for line in entries)

print(f'script_exists={str(script_path.exists()).lower()}')
print(f'log_dir_exists={str(log_dir.exists()).lower()}')
print(f'cron_present={str(present).lower()}')
print(f'schedule={cron_schedule}')
print(f'script_path={script_path}')
print(f'log_dir={log_dir}')
EOF"
}

install_remote_script() {
  local payload_b64
  payload_b64="$(base64 < "${ROOT_DIR}/scripts/ops/dingtalk-onprem-docker-gc.sh" | tr -d '\n')"
  ssh_cmd "mkdir -p '${REMOTE_BIN_DIR}' '${REMOTE_LOG_DIR}' && tmp_file=\$(mktemp) && printf '%s' '${payload_b64}' | base64 -d > \"\${tmp_file}\" && install -m 755 \"\${tmp_file}\" '${REMOTE_SCRIPT_PATH}' && rm -f \"\${tmp_file}\""
}

install_crontab() {
  ssh_cmd "REMOTE_SCRIPT_PATH='${REMOTE_SCRIPT_PATH}' REMOTE_LOG_DIR='${REMOTE_LOG_DIR}' GC_SCHEDULE_CRON='${GC_SCHEDULE_CRON}' python3 - <<'EOF'
import os
import subprocess

script_path = os.environ['REMOTE_SCRIPT_PATH']
log_dir = os.environ['REMOTE_LOG_DIR']
schedule = os.environ['GC_SCHEDULE_CRON']
cron_line = f\"{schedule} REMOTE_SELF=true {script_path} >> {log_dir}/cron.log 2>&1\"
marker = '# metasheet-onprem-docker-gc'

current = subprocess.run(['crontab', '-l'], capture_output=True, text=True)
entries = current.stdout.splitlines() if current.returncode == 0 else []
filtered = [
    line for line in entries
    if line.strip() != marker and script_path not in line
]
filtered.extend([marker, cron_line])
payload = '\\n'.join(filtered).rstrip() + '\\n'
subprocess.run(['crontab', '-'], input=payload, text=True, check=True)
print(cron_line)
EOF"
}

clear_crontab() {
  ssh_cmd "REMOTE_SCRIPT_PATH='${REMOTE_SCRIPT_PATH}' REMOTE_LOG_DIR='${REMOTE_LOG_DIR}' GC_SCHEDULE_CRON='${GC_SCHEDULE_CRON}' python3 - <<'EOF'
import os
import subprocess

script_path = os.environ['REMOTE_SCRIPT_PATH']
log_dir = os.environ['REMOTE_LOG_DIR']
schedule = os.environ['GC_SCHEDULE_CRON']
cron_line = f\"{schedule} REMOTE_SELF=true {script_path} >> {log_dir}/cron.log 2>&1\"
marker = '# metasheet-onprem-docker-gc'

current = subprocess.run(['crontab', '-l'], capture_output=True, text=True)
entries = current.stdout.splitlines() if current.returncode == 0 else []
filtered = [
    line for line in entries
    if line.strip() != marker and script_path not in line
]
if filtered:
    payload = '\\n'.join(filtered).rstrip() + '\\n'
    subprocess.run(['crontab', '-'], input=payload, text=True, check=True)
else:
    subprocess.run(['crontab', '-r'], check=False)
EOF"
}

case "${MODE}" in
  install)
    install_remote_script
    install_crontab >/dev/null
    echo "[onprem-docker-gc-install] installed ${REMOTE_SCRIPT_PATH}"
    echo "[onprem-docker-gc-install] schedule=${GC_SCHEDULE_CRON}"
    ;;
  --print-status)
    print_status
    ;;
  --clear)
    clear_crontab
    echo "[onprem-docker-gc-install] removed cron schedule"
    ;;
  *)
    echo "usage: $0 [install|--print-status|--clear]" >&2
    exit 1
    ;;
esac
