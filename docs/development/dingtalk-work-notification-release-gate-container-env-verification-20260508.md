# DingTalk Work Notification Release Gate — Container Env Skip Option Verification (2026-05-08)

## Summary

Added `--skip-env-status` to `scripts/ops/dingtalk-work-notification-release-gate.mjs`. Default behavior is unchanged. With the flag set, the host env-status helper is not invoked and no `ENV_STATUS_BLOCKED` failure is emitted; backend health, admin auth, and admin runtime workNotification status continue to run.

## Files Changed

- `scripts/ops/dingtalk-work-notification-release-gate.mjs` — new `--skip-env-status` flag, `buildSkippedEnvStatus` helper, summary fields `skipEnvStatus` / `envStatus.skipped`, markdown rendering update.
- `scripts/ops/dingtalk-work-notification-release-gate.test.mjs` — two new tests covering the skip path (pass and runtime-blocked branches).
- `docs/development/dingtalk-work-notification-release-gate-container-env-design-20260508.md` — design rationale.
- `docs/development/dingtalk-work-notification-release-gate-container-env-verification-20260508.md` — this file.

## Local Verification

Syntax check:

```bash
node --check scripts/ops/dingtalk-work-notification-release-gate.mjs
```

Result: passed.

Targeted unit tests:

```bash
node --test scripts/ops/dingtalk-work-notification-release-gate.test.mjs
```

Result: 7 tests passed (4 existing + 2 new + the existing `--skip-admin-api` case retained).

New cases covered:

- `--skip-env-status` plus healthy backend, valid admin token, and `workNotification.available=true` returns `pass` with empty failures, `envStatus.skipped=true`, `envStatus.overallStatus="not_applicable"`, and no env-status helper artifact written.
- `--skip-env-status` plus healthy backend with `workNotification.unavailableReason=missing_agent_id` returns `blocked` with exactly one failure code, `WORK_NOTIFICATION_UNAVAILABLE`, demonstrating that the runtime check is not weakened by skipping the host env probe.

Markdown assertions:

- Header line `Env Status Skipped: \`true\`` is rendered.
- Checks section renders `Env Status: \`skipped\``.

## Security Posture

- The local development and unit-test path did not read `.env`, `.secrets`, token, webhook, recipient, or remote server files.
- The live 142 verification reused a short-lived admin token file as the authenticated input to the helper. The token value was not printed, copied into Git, or included in this report.
- No secret-shaped values appear in the new code, tests, or docs. The existing redaction paths (DingTalk robot webhook, `access_token`, `SEC...`, `eyJ...` JWT, `Bearer ...`) are unchanged and still applied to all summaries.
- The new flag is a pure control-flow toggle; it does not introduce any new IO.

## 142 Live Verification

Post-merge production deployment was already running `a61b3c64b23c94137db10bce7ce166181c25d9e2` on 142 with backend `/api/health=200` and web `200`.

The updated release-gate script was copied to `/tmp` on 142 and executed with `--skip-env-status`, `--allow-blocked`, the local backend API, and a short-lived admin token file. Result:

```json
{
  "status": "blocked",
  "skipEnvStatus": true,
  "envStatus": {
    "skipped": true,
    "overallStatus": "not_applicable"
  },
  "failures": [
    {
      "code": "WORK_NOTIFICATION_UNAVAILABLE",
      "detail": {
        "unavailableReason": "missing_agent_id"
      }
    }
  ]
}
```

This proves the new flag removes the host `.env` false block while preserving the real runtime blocker: the production DingTalk work-notification Agent ID is still missing.

## 142 Usage Note

Recommended sequence on 142 while the real Agent ID is still missing:

```bash
node /tmp/dingtalk-work-notification-release-gate.mjs \
  --status-helper /tmp/dingtalk-work-notification-env-status.mjs \
  --api-base http://127.0.0.1:8900 \
  --auth-token-file /tmp/metasheet-142-admin-2h-20260508.jwt \
  --user-id b928b8d9-8881-43d7-a712-842b28870494 \
  --skip-env-status \
  --allow-blocked \
  --output-json /tmp/dingtalk-work-notification-release-gate/summary.json \
  --output-md /tmp/dingtalk-work-notification-release-gate/summary.md
```

Expected: `status=blocked`, single failure `WORK_NOTIFICATION_UNAVAILABLE` with `unavailableReason=missing_agent_id`. After Agent ID is configured, rerun without `--allow-blocked`; expected `status=pass`.

The previous (host-env) invocation still works for environments where the host `.env` is the source of truth. The new flag is opt-in and exists specifically for container-env deployments like 142.
