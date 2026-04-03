#!/usr/bin/env python3

import json
import os
import pathlib
import sys


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

    payload = None
    if json_path.is_file():
        try:
            payload = json.loads(json_path.read_text(encoding='utf-8'))
        except Exception:
            payload = None

    stability_rc = os.environ.get('STABILITY_RC', '')
    healthy = os.environ.get('HEALTHY', 'false')

    lines = ['# DingTalk OAuth Stability Recording (Lite)', '']
    status = 'PASS' if stability_rc == '0' and healthy == 'true' else 'FAIL'
    lines.append(f'- Overall: **{status}**')
    lines.append(f'- Stability rc: `{stability_rc or "missing"}`')
    lines.append(f'- Healthy: `{healthy}`')
    lines.append('')

    if payload:
        lines.append('## Snapshot')
        lines.append('')
        lines.append(f'- Checked at: `{payload.get("checkedAt", "missing")}`')
        lines.append(f'- Host: `{payload.get("host", "missing")}`')
        health = payload.get('health', {})
        webhook = payload.get('webhookConfig', {})
        alertmanager = payload.get('alertmanager', {})
        bridge = payload.get('bridge', {})
        lines.append(
            f'- Health: `status={health.get("status")} plugins={health.get("plugins")} ok={health.get("ok")}`'
        )
        lines.append(
            f'- Webhook: `configured={webhook.get("configured")} host={webhook.get("host")}`'
        )
        lines.append(
            f'- Alertmanager: `activeAlerts={alertmanager.get("activeAlertsCount")} notifyErrors={alertmanager.get("notifyErrorsLastWindow")}`'
        )
        lines.append(
            f'- Bridge: `notifyEvents={bridge.get("notifyEventsLastWindow")} resolvedEvents={bridge.get("resolvedEventsLastWindow")}`'
        )
        lines.append('')
    else:
        lines.append('## Snapshot')
        lines.append('')
        lines.append('- Stability JSON missing or unreadable.')
        lines.append('')

    lines.append('## Artifacts')
    lines.append('')
    lines.append(f'- JSON: `{json_path}`')
    lines.append(f'- Log: `{log_path}`')
    lines.append(f'- Summary: `{summary_path}`')
    summary_text = '\n'.join(lines) + '\n'

    summary_path.parent.mkdir(parents=True, exist_ok=True)
    summary_path.write_text(summary_text, encoding='utf-8')
    sys.stdout.write(summary_text)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
