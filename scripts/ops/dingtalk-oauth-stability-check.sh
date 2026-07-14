#!/bin/bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SSH_USER_HOST="${SSH_USER_HOST:-mainuser@23.254.236.11}"
SSH_KEY="${SSH_KEY:-${HOME}/.ssh/metasheet2_deploy}"
JSON_OUTPUT="${JSON_OUTPUT:-false}"
LOG_WINDOW="${LOG_WINDOW:-24h}"
MAX_ROOT_USE_PERCENT="${MAX_ROOT_USE_PERCENT:-95}"
# DT-CLOSE-01: /metrics/prom now requires METRICS_SCRAPE_TOKEN (metrics.ts createMetricsAuthMiddleware),
# so an unauthenticated scrape 401s and the whole OAuth-stability recording goes blind. Resolve the
# token on the deploy host itself (same source of truth as scripts/ops/resolve-metrics-scrape-token.sh:
# the backend container's runtime env) and attach it as the x-metrics-token header IN THE SAME remote
# shell — the secret never transits the CI runner, this script's env, or a runner-side process arg list.
# Falls back to an unauthenticated scrape only when the backend has no token configured (auth disabled).
DEPLOY_PATH="${DEPLOY_PATH:-metasheet2}"
DEPLOY_COMPOSE_FILE="${DEPLOY_COMPOSE_FILE:-docker-compose.app.yml}"

ssh_cmd() {
  ssh -i "${SSH_KEY}" -o BatchMode=yes -o StrictHostKeyChecking=no "${SSH_USER_HOST}" "$@"
}

# Scrape a token-gated endpoint on the deploy host. The token is read from the backend container's
# runtime env on the remote and used within the same remote shell (never printed, never returned to
# the runner). Args: <url>. Any remaining args after the url are appended to curl verbatim.
remote_authed_curl() {
  local url="$1"; shift || true
  ssh_cmd "DEPLOY_PATH=$(printf '%q' "${DEPLOY_PATH}") DEPLOY_COMPOSE_FILE=$(printf '%q' "${DEPLOY_COMPOSE_FILE}") URL=$(printf '%q' "${url}") bash -s" <<'REMOTE'
set -euo pipefail
if [ "${DEPLOY_PATH}" != "${DEPLOY_PATH#/}" ]; then repo="${DEPLOY_PATH}"; else repo="${HOME}/${DEPLOY_PATH}"; fi
compose=(docker compose)
docker compose version >/dev/null 2>&1 || compose=(docker-compose)
token=""
if [ -d "${repo}" ]; then
  token="$(cd "${repo}" && "${compose[@]}" -f "${DEPLOY_COMPOSE_FILE}" exec -T backend sh -lc 'printf "%s" "${METRICS_SCRAPE_TOKEN:-}"' </dev/null 2>/dev/null || true)"
fi
if [ -n "${token}" ]; then
  curl -fsS -H "x-metrics-token: ${token}" "${URL}"
else
  # No token configured on the backend => metrics auth is disabled; an unauthenticated scrape is correct.
  curl -fsS "${URL}"
fi
REMOTE
}

# DT-CLOSE-01B: this recording is a METRICS-ONLY OAuth-stability check. Its job is the OAuth
# state-machine signal (/metrics/prom, authenticated per DT-CLOSE-01), /health, and root-disk
# headroom. The Alertmanager (:9093) + metasheet-alert-webhook alert-DELIVERY topology is a
# SEPARATE concern that is NOT deployable from current main (docker/observability/ has only
# Prometheus+Grafana; the alertmanager service + webhook bridge + OAuth alert rules were never
# landed). Hard-depending on it made every scheduled run fail with `curl (7) :9093` — the OAuth
# monitor going blind because of an unrelated, undeployed topology. So the alert-topology probes
# below are SOFT (best-effort; a failure yields a "deferred" marker, not an abort) and, critically,
# the verdict (report['healthy']) does NOT depend on them. Alert-delivery observability is DEFERRED
# to a follow-up that actually deploys the topology; this check no longer claims it is "restored".
ALERT_TOPOLOGY_DEFERRED="false"
WEBHOOK_STATUS="$(bash "${ROOT_DIR}/scripts/ops/set-dingtalk-onprem-alertmanager-webhook-config.sh" --print-status 2>/dev/null || { ALERT_TOPOLOGY_DEFERRED="true"; printf 'configured=false\n'; })"
HEALTH_JSON="$(ssh_cmd "curl -fsS http://127.0.0.1:8900/health")"
METRICS_TEXT="$(remote_authed_curl "http://127.0.0.1:8900/metrics/prom")"
ALERTMANAGER_STATUS_JSON="$(ssh_cmd "curl -fsS http://127.0.0.1:9093/api/v2/status" 2>/dev/null || { ALERT_TOPOLOGY_DEFERRED="true"; printf '{}'; })"
ALERTS_JSON="$(ssh_cmd "curl -fsS http://127.0.0.1:9093/api/v2/alerts" 2>/dev/null || { ALERT_TOPOLOGY_DEFERRED="true"; printf '[]'; })"
ALERTMANAGER_ERROR_COUNT="$(ssh_cmd "docker logs --since ${LOG_WINDOW} metasheet-alertmanager 2>&1 | grep -E 'Notify for alerts failed|no_text' | wc -l | tr -d ' '" 2>/dev/null || printf '0')"
BRIDGE_NOTIFY_COUNT="$(ssh_cmd "docker logs --since ${LOG_WINDOW} metasheet-alert-webhook 2>&1 | grep '\"path\": \"/notify\"' | wc -l | tr -d ' '" 2>/dev/null || printf '0')"
BRIDGE_RESOLVED_COUNT="$(ssh_cmd "docker logs --since ${LOG_WINDOW} metasheet-alert-webhook 2>&1 | grep '\"path\": \"/notify\"' | grep '\"status\": \"resolved\"' | wc -l | tr -d ' '" 2>/dev/null || printf '0')"
ROOT_DF_LINE="$(ssh_cmd "df -P / | awk 'NR==2 {print \$2\" \"\$3\" \"\$4\" \"\$5}'")"

WEBHOOK_STATUS_INPUT="${WEBHOOK_STATUS}" \
HEALTH_JSON_INPUT="${HEALTH_JSON}" \
METRICS_TEXT_INPUT="${METRICS_TEXT}" \
ALERTMANAGER_STATUS_JSON_INPUT="${ALERTMANAGER_STATUS_JSON}" \
ALERTS_JSON_INPUT="${ALERTS_JSON}" \
ALERTMANAGER_ERROR_COUNT_INPUT="${ALERTMANAGER_ERROR_COUNT}" \
BRIDGE_NOTIFY_COUNT_INPUT="${BRIDGE_NOTIFY_COUNT}" \
BRIDGE_RESOLVED_COUNT_INPUT="${BRIDGE_RESOLVED_COUNT}" \
ROOT_DF_LINE_INPUT="${ROOT_DF_LINE}" \
SSH_USER_HOST_INPUT="${SSH_USER_HOST}" \
LOG_WINDOW_INPUT="${LOG_WINDOW}" \
MAX_ROOT_USE_PERCENT_INPUT="${MAX_ROOT_USE_PERCENT}" \
JSON_OUTPUT_INPUT="${JSON_OUTPUT}" \
ALERT_TOPOLOGY_DEFERRED_INPUT="${ALERT_TOPOLOGY_DEFERRED}" \
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
root_df_parts = os.environ.get('ROOT_DF_LINE_INPUT', '').split()
if len(root_df_parts) == 4:
    root_total, root_used, root_avail, root_percent = root_df_parts
else:
    root_total, root_used, root_avail, root_percent = ('0', '0', '0', '100%')

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
    'storage': {
        'root': {
            'totalKBlocks': int(root_total),
            'usedKBlocks': int(root_used),
            'availableKBlocks': int(root_avail),
            'usePercent': int(root_percent.rstrip('%')),
            'maxUsePercent': int(os.environ['MAX_ROOT_USE_PERCENT_INPUT']),
        },
    },
    'bridge': {
        'notifyEventsLastWindow': int(os.environ['BRIDGE_NOTIFY_COUNT_INPUT'] or '0'),
        'resolvedEventsLastWindow': int(os.environ['BRIDGE_RESOLVED_COUNT_INPUT'] or '0'),
    },
}
health_ok = (
    report['health']['ok'] is True
    or report['health']['status'] == 'ok'
)
# DT-CLOSE-01B: metrics-only OAuth-stability verdict. The OAuth signal is present when the state
# machine is emitting its operation metrics (an authenticated /metrics/prom scrape returned the
# metasheet_dingtalk_oauth_state_operations_total series). The verdict deliberately does NOT depend
# on the alert-delivery topology (webhook configured / Slack host / alertmanager notify errors) —
# that is a separate, currently-DEFERRED concern (docker/observability has no alertmanager service
# or webhook bridge on main), and coupling it in is what made the OAuth monitor go blind.
alert_topology_deferred = os.environ.get('ALERT_TOPOLOGY_DEFERRED_INPUT', 'false') == 'true'
report['alertDeliveryObservability'] = 'deferred' if alert_topology_deferred else 'observed'
oauth_metrics_present = len(report['metrics']['operationsSamples']) > 0
report['oauthMetricsPresent'] = oauth_metrics_present
report['healthy'] = (
    health_ok
    and oauth_metrics_present
    and report['storage']['root']['usePercent'] < report['storage']['root']['maxUsePercent']
)

if os.environ['JSON_OUTPUT_INPUT'] == 'true':
    print(json.dumps(report, ensure_ascii=False, indent=2))
else:
    print(f"[oauth-stability] checkedAt={report['checkedAt']}")
    print(f"[oauth-stability] host={report['host']}")
    print(f"[oauth-stability] health.status={report['health']['status']} plugins={report['health']['plugins']} ok={report['health']['ok']}")
    print(f"[oauth-stability] storage.rootUse={report['storage']['root']['usePercent']}% availKBlocks={report['storage']['root']['availableKBlocks']} maxUse={report['storage']['root']['maxUsePercent']}%")
    print(f"[oauth-stability] metrics.operations={len(report['metrics']['operationsSamples'])} fallback={len(report['metrics']['fallbackSamples'])} redis={len(report['metrics']['redisSamples'])} oauthMetricsPresent={str(report['oauthMetricsPresent']).lower()}")
    print(f"[oauth-stability] alertDeliveryObservability={report['alertDeliveryObservability']} (DEFERRED means the Alertmanager+webhook topology is not deployed — NOT part of the OAuth verdict)")
    print(f"[oauth-stability] webhook.configured={report['webhookConfig']['configured']} alertmanager.notifyErrors={report['alertmanager']['notifyErrorsLastWindow']} bridge.notifyEvents={report['bridge']['notifyEventsLastWindow']} (informational only)")
    print(f"[oauth-stability] healthy={str(report['healthy']).lower()}")
EOF
