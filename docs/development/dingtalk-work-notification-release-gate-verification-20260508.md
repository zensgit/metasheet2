# DingTalk Work Notification Release Gate Verification (2026-05-08)

## Summary

Added a redaction-safe release gate for DingTalk work-notification readiness. It composes env readiness, backend health, admin auth, and admin runtime `workNotification` status into one `pass` or `blocked` result.

142 is still blocked because the real Agent ID has not been configured. The gate correctly reports that state without modifying production env.

## Local Verification

Syntax check:

```bash
node --check scripts/ops/dingtalk-work-notification-release-gate.mjs
```

Result: passed.

Unit tests:

```bash
node --test scripts/ops/dingtalk-work-notification-release-gate.test.mjs
```

Result: passed, 4 tests.

Covered cases:

- Ready env plus healthy backend and available `workNotification` returns `pass`.
- Missing Agent ID returns `blocked` with `ENV_STATUS_BLOCKED` and `WORK_NOTIFICATION_UNAVAILABLE`.
- Sensitive API error payloads are redacted from JSON and Markdown.
- `--skip-admin-api` allows env plus health checks without a token or user id.

Scoped leak scan:

```bash
rg -n "(oapi\\.dingtalk\\.com/robot/send\\?access_token=|SEC[A-Za-z0-9]{16,}|eyJ[a-zA-Z0-9_-]{20,}\\.|access_token=[A-Za-z0-9]{20,})" \
  scripts/ops/dingtalk-work-notification-release-gate.mjs \
  scripts/ops/dingtalk-work-notification-release-gate.test.mjs \
  docs/development/dingtalk-work-notification-release-gate-design-20260508.md \
  docs/development/dingtalk-work-notification-release-gate-verification-20260508.md
```

Result: no real secret matches.

Whitespace check:

```bash
git diff --check -- \
  scripts/ops/dingtalk-work-notification-release-gate.mjs \
  scripts/ops/dingtalk-work-notification-release-gate.test.mjs \
  docs/development/dingtalk-work-notification-release-gate-design-20260508.md \
  docs/development/dingtalk-work-notification-release-gate-verification-20260508.md
```

Result: passed.

## 142 Verification

The release gate helper was copied to `/tmp` and checked:

```bash
scp scripts/ops/dingtalk-work-notification-release-gate.mjs \
  metasheet-142:/tmp/dingtalk-work-notification-release-gate.mjs
ssh metasheet-142 'node --check /tmp/dingtalk-work-notification-release-gate.mjs'
```

Result: passed.

A short-lived admin token file was generated inside the backend runtime for this
gate only:

- Token file: `/tmp/metasheet-142-admin-release-gate-2h.jwt`
- File mode: `600`
- Token value: not printed and not written to this document.

142 current status:

- Image tag: `8f5bd7f4bbac3a2fe6298b3293f476628e224065`
- Env status: `blocked`
- App key: present
- App secret: present
- Agent ID: missing

Gate result on 142:

- `status=blocked`
- `envStatus.overallStatus=blocked`
- `health.ok=true`
- `auth.ok=true`
- `workNotification.available=false`
- Failure codes: `ENV_STATUS_BLOCKED`, `WORK_NOTIFICATION_UNAVAILABLE`

Redacted command output:

```json
{
  "status": "blocked",
  "envStatus": "blocked",
  "health": true,
  "auth": true,
  "workNotification": false,
  "failures": [
    "ENV_STATUS_BLOCKED",
    "WORK_NOTIFICATION_UNAVAILABLE"
  ]
}
```

This is expected until the real Agent ID is written to `/home/mainuser/metasheet2/.secrets/dingtalk-agent-id.txt` and applied.
