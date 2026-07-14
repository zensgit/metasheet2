#!/usr/bin/env python3

import json
import os
import pathlib
import sys
from typing import Any, Optional


def load_json(path: pathlib.Path) -> Optional[dict[str, Any]]:
    if not path.is_file():
        return None
    try:
        return json.loads(path.read_text(encoding='utf-8'))
    except Exception:
        return None


def github_run_url() -> str:
    server = os.environ.get('GITHUB_SERVER_URL', '')
    repository = os.environ.get('GITHUB_REPOSITORY', '')
    run_id = os.environ.get('GITHUB_RUN_ID', '')
    if server and repository and run_id:
        return f'{server}/{repository}/actions/runs/{run_id}'
    return ''


def infer_failure_reasons(
    payload: Optional[dict[str, Any]],
    stability_rc: str,
    healthy: str,
) -> list[str]:
    # DT-CLOSE-01B: the health verdict is metrics-only — health_ok AND oauthMetricsPresent AND
    # storage-headroom (see dingtalk-oauth-stability-check.sh). Alert-DELIVERY topology (webhook
    # configured / host / Alertmanager notify errors) is a separate, currently-DEFERRED concern and
    # must NEVER appear here: gating narration on it is what let a real OAuth-metrics outage get
    # misattributed to "webhook not configured" while the actual failing signal went unreported.
    reasons: list[str] = []
    if stability_rc != '0':
        reasons.append(f'stability-check command failed (rc={stability_rc or "missing"})')
    if payload is None:
        reasons.append('stability JSON missing or unreadable')
        return reasons
    if healthy != 'true':
        health = payload.get('health', {}) or {}
        storage = ((payload.get('storage') or {}).get('root') or {})
        oauth_metrics_present = payload.get('oauthMetricsPresent')

        if not (health.get('ok') is True or health.get('status') == 'ok'):
            reasons.append(
                f'backend health is not ok (status={health.get("status")} ok={health.get("ok")})'
            )
        if oauth_metrics_present is not True:
            reasons.append(
                'OAuth state-operation metrics are absent from /metrics/prom (producer not '
                'running/not deployed, or the scrape is broken)'
            )
        if int(storage.get('usePercent') or 0) >= int(storage.get('maxUsePercent') or 0):
            reasons.append(
                f'root filesystem is at or above gate ({storage.get("usePercent")}% / {storage.get("maxUsePercent")}% max)'
            )
    return reasons


def infer_next_actions(
    payload: Optional[dict[str, Any]],
    failure_reasons: list[str],
) -> list[str]:
    if not failure_reasons:
        actions = ['Continue observing scheduled GitHub runs and local launchd drill cadence.']
        if payload:
            storage = ((payload.get('storage') or {}).get('root') or {})
            use_percent = int(storage.get('usePercent') or 0)
            max_use_percent = int(storage.get('maxUsePercent') or 0)
            if max_use_percent and use_percent >= max_use_percent - 5:
                actions.append(
                    f'Plan a remote Docker image/cache cleanup soon because root usage is approaching the gate ({use_percent}% / {max_use_percent}%).'
                )
    else:
        actions = []
        for reason in failure_reasons:
            if 'stability-check command failed' in reason:
                actions.append('Re-run the workflow log tail and remote SSH stability check to isolate the failing command.')
            elif 'backend health is not ok' in reason:
                actions.append('Check the on-prem backend container health and `/health` response before retrying the workflow.')
            elif 'OAuth state-operation metrics are absent' in reason:
                actions.append(
                    'Verify the backend container is up, confirm the METRICS_SCRAPE_TOKEN handshake succeeds '
                    'against /metrics/prom, and confirm the deployed image actually contains the OAuth '
                    'state-metrics producer.'
                )
            elif 'root filesystem is at or above gate' in reason:
                actions.append('Run the on-prem Docker GC flow or free disk space on the remote host, then retry the stability workflow.')
            elif 'JSON missing or unreadable' in reason:
                actions.append('Check the uploaded log artifact first; the workflow did not produce a readable stability JSON payload.')

    # Alert-delivery topology is deferred by design and is never a failure reason, but it is
    # always worth surfacing as context — independent of whether the run passed or failed.
    if payload and payload.get('alertDeliveryObservability') == 'deferred':
        actions.append(
            'Alert-delivery observability reading as deferred is expected until the '
            'Alertmanager+bridge topology ships; see the switch ledger.'
        )

    deduped: list[str] = []
    for action in actions:
        if action not in deduped:
            deduped.append(action)
    return deduped


def make_summary_payload(
    payload: Optional[dict[str, Any]],
    stability_rc: str,
    healthy: str,
    json_path: pathlib.Path,
    log_path: pathlib.Path,
    summary_path: pathlib.Path,
) -> dict[str, Any]:
    status = 'PASS' if stability_rc == '0' and healthy == 'true' else 'FAIL'
    run_url = github_run_url()
    webhook_secret_available = os.environ.get('WEBHOOK_SECRET_AVAILABLE', 'false')
    failure_reasons = infer_failure_reasons(payload, stability_rc, healthy)
    next_actions = infer_next_actions(payload, failure_reasons)
    summary_json_path = summary_path.with_suffix('.json')

    return {
        'status': status,
        'stabilityRc': stability_rc or 'missing',
        'healthy': healthy == 'true',
        'failureReasons': failure_reasons,
        'nextActions': next_actions,
        'checkedAt': (payload or {}).get('checkedAt'),
        'host': (payload or {}).get('host'),
        'workflow': {
            'name': os.environ.get('GITHUB_WORKFLOW', ''),
            'event': os.environ.get('GITHUB_EVENT_NAME', ''),
            'refName': os.environ.get('GITHUB_REF_NAME', ''),
            'runId': os.environ.get('GITHUB_RUN_ID', ''),
            'runAttempt': os.environ.get('GITHUB_RUN_ATTEMPT', ''),
            'runUrl': run_url,
        },
        'selfHeal': {
            'webhookSecretAvailable': webhook_secret_available == 'true',
        },
        'snapshot': payload,
        'artifacts': {
            'jsonPath': str(json_path),
            'logPath': str(log_path),
            'summaryMarkdownPath': str(summary_path),
            'summaryJsonPath': str(summary_json_path),
        },
    }


def alert_delivery_observability_lines(
    payload: Optional[dict[str, Any]],
    webhook_secret_available: bool,
) -> list[str]:
    # Always emitted — this is context, never a gate. The verdict (see infer_failure_reasons)
    # does not depend on any of this; it exists so a human can see why the topology reads the
    # way it does without mistaking it for a health failure.
    lines = ['## Alert Delivery Observability', '']
    if not payload:
        lines.append('- Stability JSON missing or unreadable; alert-delivery observability unknown.')
        lines.append('')
        return lines

    observability = payload.get('alertDeliveryObservability')
    webhook = payload.get('webhookConfig', {}) or {}
    alertmanager = payload.get('alertmanager', {}) or {}

    if observability == 'observed':
        lines.append(
            '- State: `observed` — the Alertmanager + webhook bridge topology is deployed and the webhook is configured.'
        )
        notify_errors = int(alertmanager.get('notifyErrorsLastWindow') or 0)
        if notify_errors > 0:
            lines.append(
                f'- WARNING: Alertmanager reported {notify_errors} delivery error(s) in the current log window. '
                'This is informational only and is NOT a failure reason for the OAuth-stability health verdict.'
            )
    else:
        lines.append(
            '- State: `deferred` — the alert-delivery topology (Alertmanager :9093 / webhook bridge) is deferred '
            'by design and is NOT part of the OAuth-stability health verdict.'
        )
        lines.append(f'- Webhook configured (context only): `{webhook.get("configured")}`')

    lines.append(
        f'- Webhook self-heal secret available: `{str(bool(webhook_secret_available)).lower()}` (informational only).'
    )
    lines.append('')
    return lines


def markdown_lines(summary: dict[str, Any]) -> list[str]:
    payload = summary.get('snapshot') or {}
    lines = ['# DingTalk OAuth Stability Recording (Lite)', '']
    lines.append(f'- Overall: **{summary["status"]}**')
    lines.append(f'- Stability rc: `{summary["stabilityRc"]}`')
    lines.append(f'- Healthy: `{str(summary["healthy"]).lower()}`')
    workflow = summary.get('workflow') or {}
    self_heal = summary.get('selfHeal') or {}
    run_url = workflow.get('runUrl')
    if run_url:
        lines.append(f'- Run URL: `{run_url}`')
    lines.append('')

    if payload:
        lines.append('## Snapshot')
        lines.append('')
        lines.append(f'- Checked at: `{payload.get("checkedAt", "missing")}`')
        lines.append(f'- Host: `{payload.get("host", "missing")}`')
        health = payload.get('health', {}) or {}
        webhook = payload.get('webhookConfig', {}) or {}
        alertmanager = payload.get('alertmanager', {}) or {}
        bridge = payload.get('bridge', {}) or {}
        storage = ((payload.get('storage') or {}).get('root') or {})
        lines.append(
            f'- Health: `status={health.get("status")} plugins={health.get("plugins")} ok={health.get("ok")}`'
        )
        lines.append(
            f'- Webhook: `configured={webhook.get("configured")} host={webhook.get("host")}`'
        )
        lines.append(
            f'- Alertmanager: `activeAlerts={alertmanager.get("activeAlertsCount")} notifyErrors={alertmanager.get("notifyErrorsLastWindow")}`'
        )
        if storage:
            lines.append(
                f'- Storage: `rootUse={storage.get("usePercent")}% availKBlocks={storage.get("availableKBlocks")} maxUse={storage.get("maxUsePercent")}%`'
            )
        lines.append(
            f'- Bridge: `notifyEvents={bridge.get("notifyEventsLastWindow")} resolvedEvents={bridge.get("resolvedEventsLastWindow")}`'
        )
        metrics = payload.get('metrics', {}) or {}
        lines.append(
            f'- Metrics samples: `operations={len(metrics.get("operationsSamples") or [])} fallback={len(metrics.get("fallbackSamples") or [])} redis={len(metrics.get("redisSamples") or [])}`'
        )
        lines.append('')
    else:
        lines.append('## Snapshot')
        lines.append('')
        lines.append('- Stability JSON missing or unreadable.')
        lines.append('')

    lines.append('## Outcome')
    lines.append('')
    failure_reasons = summary.get('failureReasons') or []
    if failure_reasons:
        for reason in failure_reasons:
            lines.append(f'- Failure reason: {reason}')
    else:
        lines.append('- No blocking failure reasons detected.')
    lines.append('')

    lines.extend(
        alert_delivery_observability_lines(payload, bool(self_heal.get('webhookSecretAvailable')))
    )

    lines.append('## Next Actions')
    lines.append('')
    for action in summary.get('nextActions') or []:
        lines.append(f'- {action}')
    lines.append('')

    lines.append('## Artifacts')
    lines.append('')
    artifacts = summary.get('artifacts') or {}
    lines.append(f'- JSON: `{artifacts.get("jsonPath", "")}`')
    lines.append(f'- Log: `{artifacts.get("logPath", "")}`')
    lines.append(f'- Summary Markdown: `{artifacts.get("summaryMarkdownPath", "")}`')
    lines.append(f'- Summary JSON: `{artifacts.get("summaryJsonPath", "")}`')
    return lines


def main() -> int:
    if len(sys.argv) != 4:
        print(
            'usage: github-dingtalk-oauth-stability-summary.py <json-path> <log-path> <summary-path>',
            file=sys.stderr,
        )
        return 1

    json_path = pathlib.Path(sys.argv[1])
    log_path = pathlib.Path(sys.argv[2])
    summary_path = pathlib.Path(sys.argv[3])
    summary_json_path = summary_path.with_suffix('.json')
    payload = load_json(json_path)
    stability_rc = os.environ.get('STABILITY_RC', '')
    healthy = os.environ.get('HEALTHY', 'false')

    summary = make_summary_payload(
        payload=payload,
        stability_rc=stability_rc,
        healthy=healthy,
        json_path=json_path,
        log_path=log_path,
        summary_path=summary_path,
    )
    summary_text = '\n'.join(markdown_lines(summary)) + '\n'

    summary_path.parent.mkdir(parents=True, exist_ok=True)
    summary_path.write_text(summary_text, encoding='utf-8')
    summary_json_path.write_text(
        json.dumps(summary, ensure_ascii=False, indent=2) + '\n',
        encoding='utf-8',
    )
    sys.stdout.write(summary_text)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
