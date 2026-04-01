#!/bin/bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SSH_USER_HOST="${SSH_USER_HOST:-mainuser@142.171.239.56}"
SSH_KEY="${SSH_KEY:-${HOME}/.ssh/metasheet2_deploy}"
JSON_OUTPUT="${JSON_OUTPUT:-false}"
LOG_WINDOW="${LOG_WINDOW:-24h}"

ssh_cmd() {
  ssh -i "${SSH_KEY}" -o BatchMode=yes -o StrictHostKeyChecking=no "${SSH_USER_HOST}" "$@"
}

WEBHOOK_STATUS="$(bash "${ROOT_DIR}/scripts/ops/set-dingtalk-onprem-alertmanager-webhook-config.sh" --print-status)"
HEALTH_JSON="$(ssh_cmd "curl -fsS http://127.0.0.1:8900/health")"
METRICS_TEXT="$(ssh_cmd "curl -fsS http://127.0.0.1:8900/metrics/prom")"
ALERTMANAGER_STATUS_JSON="$(ssh_cmd "curl -fsS http://127.0.0.1:9093/api/v2/status")"
ALERTS_JSON="$(ssh_cmd "curl -fsS http://127.0.0.1:9093/api/v2/alerts")"
ALERTMANAGER_ERROR_COUNT="$(ssh_cmd "docker logs --since ${LOG_WINDOW} metasheet-alertmanager 2>&1 | grep -E 'Notify for alerts failed|no_text' | wc -l | tr -d ' '")"
BRIDGE_NOTIFY_COUNT="$(ssh_cmd "docker logs --since ${LOG_WINDOW} metasheet-alert-webhook 2>&1 | grep '\"path\": \"/notify\"' | wc -l | tr -d ' '")"
BRIDGE_RESOLVED_COUNT="$(ssh_cmd "docker logs --since ${LOG_WINDOW} metasheet-alert-webhook 2>&1 | grep '\"path\": \"/notify\"' | grep '\"status\": \"resolved\"' | wc -l | tr -d ' '")"

WEBHOOK_STATUS_INPUT="${WEBHOOK_STATUS}" \
HEALTH_JSON_INPUT="${HEALTH_JSON}" \
METRICS_TEXT_INPUT="${METRICS_TEXT}" \
ALERTMANAGER_STATUS_JSON_INPUT="${ALERTMANAGER_STATUS_JSON}" \
ALERTS_JSON_INPUT="${ALERTS_JSON}" \
ALERTMANAGER_ERROR_COUNT_INPUT="${ALERTMANAGER_ERROR_COUNT}" \
BRIDGE_NOTIFY_COUNT_INPUT="${BRIDGE_NOTIFY_COUNT}" \
BRIDGE_RESOLVED_COUNT_INPUT="${BRIDGE_RESOLVED_COUNT}" \
SSH_USER_HOST_INPUT="${SSH_USER_HOST}" \
LOG_WINDOW_INPUT="${LOG_WINDOW}" \
JSON_OUTPUT_INPUT="${JSON_OUTPUT}" \
python3 - <<'EOF'
import json
import os
from datetime import datetime, timezone

webhook_status_lines = os.environ['WEBHOOK_STATUS_INPUT'].splitlines()
webhook_status = {}
for line in webhook_status_lines:
    if '=' in line:
        key, value = line.split('=', 1)
        webhook_status[key] = value

health = json.loads(os.environ['HEALTH_JSON_INPUT'])
metrics_lines = os.environ['METRICS_TEXT_INPUT'].splitlines()
alertmanager_status = json.loads(os.environ['ALERTMANAGER_STATUS_JSON_INPUT'])
alerts = json.loads(os.environ['ALERTS_JSON_INPUT'])

def matching(prefixes):
    out = []
    for line in metrics_lines:
        if any(line.startswith(prefix) for prefix in prefixes):
            out.append(line)
    return out

operations = matching(['metasheet_dingtalk_oauth_state_operations_total'])
fallbacks = matching(['metasheet_dingtalk_oauth_state_fallback_total'])
redis = matching(['redis_operation_duration_seconds_sum{op="dingtalk_oauth_state_write"',
                  'redis_operation_duration_seconds_count{op="dingtalk_oauth_state_write"',
                  'redis_operation_duration_seconds_sum{op="dingtalk_oauth_state_validate"',
                  'redis_operation_duration_seconds_count{op="dingtalk_oauth_state_validate"'])

report = {
    'checkedAt': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'),
    'host': os.environ['SSH_USER_HOST_INPUT'],
    'logWindow': os.environ['LOG_WINDOW_INPUT'],
    'health': {
        'status': health.get('status'),
        'plugins': health.get('plugins'),
        'ok': health.get('ok', health.get('success')),
        'dbPool': health.get('dbPool'),
    },
    'webhookConfig': {
        'configured': webhook_status.get('configured', 'false') == 'true',
        'scheme': webhook_status.get('scheme', ''),
        'host': webhook_status.get('host', ''),
        'pathLength': int(webhook_status.get('path_length', '0') or '0'),
    },
    'metrics': {
        'operationsSamples': operations,
        'fallbackSamples': fallbacks,
        'redisSamples': redis,
    },
    'alertmanager': {
        'uptime': alertmanager_status.get('uptime'),
        'activeAlertsCount': len(alerts),
        'notifyErrorsLastWindow': int(os.environ['ALERTMANAGER_ERROR_COUNT_INPUT'] or '0'),
    },
    'bridge': {
        'notifyEventsLastWindow': int(os.environ['BRIDGE_NOTIFY_COUNT_INPUT'] or '0'),
        'resolvedEventsLastWindow': int(os.environ['BRIDGE_RESOLVED_COUNT_INPUT'] or '0'),
    },
}
report['healthy'] = (
    report['health']['ok'] is True
    and report['webhookConfig']['configured'] is True
    and report['webhookConfig']['host'] == 'hooks.slack.com'
    and report['alertmanager']['notifyErrorsLastWindow'] == 0
)

if os.environ['JSON_OUTPUT_INPUT'] == 'true':
    print(json.dumps(report, ensure_ascii=False, indent=2))
else:
    print(f"[oauth-stability] checkedAt={report['checkedAt']}")
    print(f"[oauth-stability] host={report['host']}")
    print(f"[oauth-stability] health.status={report['health']['status']} plugins={report['health']['plugins']} ok={report['health']['ok']}")
    print(f"[oauth-stability] webhook.configured={report['webhookConfig']['configured']} host={report['webhookConfig']['host']}")
    print(f"[oauth-stability] alertmanager.activeAlerts={report['alertmanager']['activeAlertsCount']} notifyErrors={report['alertmanager']['notifyErrorsLastWindow']}")
    print(f"[oauth-stability] bridge.notifyEvents={report['bridge']['notifyEventsLastWindow']} resolvedEvents={report['bridge']['resolvedEventsLastWindow']}")
    print(f"[oauth-stability] metrics.operations={len(report['metrics']['operationsSamples'])} fallback={len(report['metrics']['fallbackSamples'])} redis={len(report['metrics']['redisSamples'])}")
    print(f"[oauth-stability] healthy={str(report['healthy']).lower()}")
EOF
