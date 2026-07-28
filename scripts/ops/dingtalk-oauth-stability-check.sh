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

# Fail-honest docker-logs match-count pipeline builders (alertmanager_error_count_cmd,
# bridge_notify_count_cmd, bridge_resolved_count_cmd) — see the file for the contract.
# shellcheck source=./dingtalk-oauth-stability-log-probe-cmds.sh
source "${ROOT_DIR}/scripts/ops/dingtalk-oauth-stability-log-probe-cmds.sh"

# DT-CLOSE-01C (rc=126 / E2BIG): scratch dir for the large scraped payloads handed to the verdict
# python below. `mktemp -d` creates it 0700-owned-by-us; the EXIT trap removes it. It deliberately
# lives under TMPDIR, NOT under output/ — the recording workflow uploads output/github/... as a
# build artifact, and these files can contain hostnames/tokens from the raw scrapes.
PAYLOAD_DIR="$(mktemp -d "${TMPDIR:-/tmp}/dingtalk-oauth-stability.XXXXXX")"
cleanup_payload_dir() {
  rm -rf "${PAYLOAD_DIR}"
}
trap cleanup_payload_dir EXIT

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
# NOTE: each of these SIX probes (webhook-status, alertmanager-status, alerts, and the three
# docker-logs match-count probes below) must set ALERT_TOPOLOGY_DEFERRED from the PARENT shell on
# failure. `WEBHOOK_STATUS="$(cmd || { ALERT_TOPOLOGY_DEFERRED=true; ... })"` is a bug: the `|| { ... }`
# runs INSIDE the `$( ... )` command substitution, which is a SUBSHELL — the assignment never
# propagates to the parent shell and ALERT_TOPOLOGY_DEFERRED silently stays "false" even when the
# probe failed. Repro: `X=false; Y=$(false || { X=true; echo z; }); echo $X` prints `false`. Use a
# parent-shell if/else instead so the assignment sticks; the `if` consumes the non-zero exit so
# `set -e` does not abort.
if WEBHOOK_STATUS="$(bash "${ROOT_DIR}/scripts/ops/set-dingtalk-onprem-alertmanager-webhook-config.sh" --print-status 2>/dev/null)"; then
  :
else
  ALERT_TOPOLOGY_DEFERRED="true"
  WEBHOOK_STATUS="configured=false"
fi
HEALTH_JSON="$(ssh_cmd "curl -fsS http://127.0.0.1:8900/health")"
METRICS_TEXT="$(remote_authed_curl "http://127.0.0.1:8900/metrics/prom")"
if ALERTMANAGER_STATUS_JSON="$(ssh_cmd "curl -fsS http://127.0.0.1:9093/api/v2/status" 2>/dev/null)"; then
  :
else
  ALERT_TOPOLOGY_DEFERRED="true"
  ALERTMANAGER_STATUS_JSON='{}'
fi
if ALERTS_JSON="$(ssh_cmd "curl -fsS http://127.0.0.1:9093/api/v2/alerts" 2>/dev/null)"; then
  :
else
  ALERT_TOPOLOGY_DEFERRED="true"
  ALERTS_JSON='[]'
fi
# SECOND bug class (distinct from the subshell-assignment one above): these three probes pipe
# `docker logs | grep | wc -l` over ssh. `wc -l` ALWAYS exits 0 no matter what fed it, so a `docker
# logs` failure (container missing, daemon down) used to be silently reported as a successful "0"
# count — the `|| printf 0` local fallback never even ran, because the remote pipeline itself never
# failed. The pipeline strings below (built by the sourced dingtalk-oauth-stability-log-probe-cmds.sh)
# enable `pipefail` on the remote shell so a `docker logs` failure propagates as a non-zero exit while
# a genuine zero-match read still exits 0 — see that file for the full contract. Combined with the
# parent-shell if/else here, a probe failure now correctly sets ALERT_TOPOLOGY_DEFERRED instead of
# being read as "0 events, alert delivery topology fine".
# `set -o pipefail` is bash-only, so the pipeline is run under an EXPLICIT `bash -c` on the remote
# (parity with remote_authed_curl's `bash -s` above) instead of trusting the remote login shell to be
# bash. A non-bash login shell would have aborted on `set -o pipefail` (fail-safe → deferred), but
# forcing bash makes the probe work — not just fail safely — regardless of the login-shell config.
# `printf '%q'` re-quotes the pipeline as backslash-escaped words (no control chars in these strings,
# so no $'…' forms), which any POSIX login shell can hand to bash unmangled.
if ALERTMANAGER_ERROR_COUNT="$(ssh_cmd "bash -c $(printf '%q' "$(alertmanager_error_count_cmd)")" 2>/dev/null)"; then
  :
else
  ALERT_TOPOLOGY_DEFERRED="true"
  ALERTMANAGER_ERROR_COUNT="0"
fi
if BRIDGE_NOTIFY_COUNT="$(ssh_cmd "bash -c $(printf '%q' "$(bridge_notify_count_cmd)")" 2>/dev/null)"; then
  :
else
  ALERT_TOPOLOGY_DEFERRED="true"
  BRIDGE_NOTIFY_COUNT="0"
fi
if BRIDGE_RESOLVED_COUNT="$(ssh_cmd "bash -c $(printf '%q' "$(bridge_resolved_count_cmd)")" 2>/dev/null)"; then
  :
else
  ALERT_TOPOLOGY_DEFERRED="true"
  BRIDGE_RESOLVED_COUNT="0"
fi
ROOT_DF_LINE="$(ssh_cmd "df -P / | awk 'NR==2 {print \$2\" \"\$3\" \"\$4\" \"\$5}'")"

# DT-CLOSE-01C: the scraped payloads are passed to the verdict python by FILE PATH, never by env
# var or argv.
#
# The regression this fixes: these five values used to be exported as `NAME_INPUT="${VALUE}" python3 …`.
# A process's argv+envp share one kernel budget (ARG_MAX; on Linux each individual string is
# additionally capped at MAX_ARG_STRLEN = 128 KiB), and METRICS_TEXT is a full `/metrics/prom` scrape
# whose size is unbounded and grows with the deploy host's metric cardinality. Once it crossed the
# limit, `execve()` returned E2BIG, bash reported
#     dingtalk-oauth-stability-check.sh: line 126: /usr/bin/python3: Argument list too long
# and exited 126 — so EVERY scheduled recording failed at the command level, regardless of how healthy
# the host actually was. A file path is a fixed ~40 bytes no matter how large the payload is.
#
# `printf` is a bash builtin, so writing these out never execs anything and cannot itself hit E2BIG.
printf '%s' "${WEBHOOK_STATUS}" >"${PAYLOAD_DIR}/webhook-status.txt"
printf '%s' "${HEALTH_JSON}" >"${PAYLOAD_DIR}/health.json"
printf '%s' "${METRICS_TEXT}" >"${PAYLOAD_DIR}/metrics.prom"
printf '%s' "${ALERTMANAGER_STATUS_JSON}" >"${PAYLOAD_DIR}/alertmanager-status.json"
printf '%s' "${ALERTS_JSON}" >"${PAYLOAD_DIR}/alerts.json"

# Only the *_FILE forms are set here — never the *_INPUT forms for these five, since setting both
# would put the payload back in envp and re-open E2BIG. read_input()'s *_INPUT fallback exists solely
# for the hermetic unit test that injects small literal values
# (dingtalk-oauth-stability-metrics-only-contract.test.mjs); the full-script ARG_MAX test
# (dingtalk-oauth-stability-argmax-payload.test.mjs) is what keeps THIS call site from reverting to it.
# The remaining variables below are bounded scalars (counts, a df line, flags) and stay in env.
WEBHOOK_STATUS_FILE="${PAYLOAD_DIR}/webhook-status.txt" \
HEALTH_JSON_FILE="${PAYLOAD_DIR}/health.json" \
METRICS_TEXT_FILE="${PAYLOAD_DIR}/metrics.prom" \
ALERTMANAGER_STATUS_JSON_FILE="${PAYLOAD_DIR}/alertmanager-status.json" \
ALERTS_JSON_FILE="${PAYLOAD_DIR}/alerts.json" \
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


def read_input(name):
    """Read one scraped payload.

    DT-CLOSE-01C: the caller passes these by FILE PATH (<NAME>_FILE), because an unbounded
    /metrics/prom scrape in envp blew the kernel argv+env budget and made execve() fail with E2BIG
    ("Argument list too long", rc=126) on every scheduled run. The <NAME>_INPUT env fallback is kept
    only so the hermetic verdict unit test can inject small literal values directly; the shell above
    must never use it for these payloads.
    """
    path = os.environ.get(name + '_FILE')
    if path:
        with open(path, 'r', encoding='utf-8') as handle:
            return handle.read()
    return os.environ[name + '_INPUT']


webhook_status_lines = read_input('WEBHOOK_STATUS').splitlines()
webhook_status = {}
for line in webhook_status_lines:
    if '=' in line:
        key, value = line.split('=', 1)
        webhook_status[key] = value

health = json.loads(read_input('HEALTH_JSON'))
metrics_lines = read_input('METRICS_TEXT').splitlines()
alertmanager_status = json.loads(read_input('ALERTMANAGER_STATUS_JSON'))
alerts = json.loads(read_input('ALERTS_JSON'))
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
# THREE-STATE: 'observed' requires BOTH (i) none of the alert-topology probes failed AND (ii) the
# webhook is actually configured. A reachable-but-UNCONFIGURED webhook (the config script can exit 0
# and print `configured=false` — Alertmanager up, nothing to notify) must also read as deferred, not
# observed: printing a success exit code is not the same as having delivery observability.
alert_topology_observed = (not alert_topology_deferred) and report['webhookConfig']['configured'] is True
report['alertDeliveryObservability'] = 'observed' if alert_topology_observed else 'deferred'
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
