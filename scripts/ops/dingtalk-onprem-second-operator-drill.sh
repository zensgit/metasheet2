#!/bin/bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

echo "[second-operator-drill] checking persisted webhook status"
bash "${ROOT_DIR}/scripts/ops/set-dingtalk-onprem-alertmanager-webhook-config.sh" --print-status

echo "[second-operator-drill] applying on-prem notify rollout"
bash "${ROOT_DIR}/scripts/ops/dingtalk-onprem-alert-notify-rollout.sh"

echo "[second-operator-drill] running machine-side stability check"
bash "${ROOT_DIR}/scripts/ops/dingtalk-oauth-stability-check.sh"

echo "[second-operator-drill] running firing/resolved drill"
DRILL_JSON="$(JSON_OUTPUT=true bash "${ROOT_DIR}/scripts/ops/dingtalk-onprem-alert-drill.sh")"
echo "${DRILL_JSON}"

DRILL_ID="$(DRILL_JSON_INPUT="${DRILL_JSON}" python3 - <<'EOF'
import json
import os

lines = [line for line in os.environ['DRILL_JSON_INPUT'].splitlines() if line.strip()]
payload_line = next((line for line in reversed(lines) if line.lstrip().startswith('{')), '')
if not payload_line:
    raise SystemExit('missing JSON payload from dingtalk-onprem-alert-drill.sh')
payload = json.loads(payload_line)
print(payload['drillId'])
EOF
)"

echo "[second-operator-drill] manual verification required"
echo "[second-operator-drill] open Slack channel #metasheet-alerts and confirm both messages exist for drillId=${DRILL_ID}"
echo "[second-operator-drill] expected messages:"
echo "[second-operator-drill]   [FIRING] DingTalkOAuthSlackChannelDrill ..."
echo "[second-operator-drill]   [RESOLVED] DingTalkOAuthSlackChannelDrill ..."
