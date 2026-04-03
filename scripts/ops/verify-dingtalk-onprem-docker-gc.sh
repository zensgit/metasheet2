#!/bin/bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
JSON_OUTPUT="${JSON_OUTPUT:-false}"

STATUS_OUTPUT="$(bash "${ROOT_DIR}/scripts/ops/install-dingtalk-onprem-docker-gc.sh" --print-status)"
GC_JSON="$(JSON_OUTPUT=true bash "${ROOT_DIR}/scripts/ops/dingtalk-onprem-docker-gc.sh")"

STATUS_OUTPUT_INPUT="${STATUS_OUTPUT}" GC_JSON_INPUT="${GC_JSON}" JSON_OUTPUT_INPUT="${JSON_OUTPUT}" python3 - <<'EOF'
import json
import os

status = {}
for line in os.environ['STATUS_OUTPUT_INPUT'].splitlines():
    if '=' in line:
        key, value = line.split('=', 1)
        status[key] = value

gc = json.loads(os.environ['GC_JSON_INPUT'])
report = {
    'installStatus': status,
    'gc': gc,
}
report['ok'] = (
    status.get('script_exists') == 'true'
    and status.get('log_dir_exists') == 'true'
    and status.get('cron_present') == 'true'
    and gc.get('ok') is True
)

if os.environ['JSON_OUTPUT_INPUT'] == 'true':
    print(json.dumps(report, ensure_ascii=False, indent=2))
else:
    print(f"[verify-onprem-docker-gc] script_exists={status.get('script_exists')}")
    print(f"[verify-onprem-docker-gc] cron_present={status.get('cron_present')}")
    print(f"[verify-onprem-docker-gc] root.use.after={gc['disk']['after']['usePercent']}% availKBlocks={gc['disk']['after']['availableKBlocks']}")
    print(f"[verify-onprem-docker-gc] images.removed={gc['images']['removedCount']} danglingRemoved={gc['images']['danglingRemovedCount']}")
    print(f"[verify-onprem-docker-gc] ok={str(report['ok']).lower()}")
EOF
