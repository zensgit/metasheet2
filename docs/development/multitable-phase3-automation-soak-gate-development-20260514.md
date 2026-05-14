# Multitable Phase 3 Automation Soak Gate - Development

Date: 2026-05-14

## Scope

This slice implements Phase 3 PR R4 / Lane D4 by replacing the
`automation:soak` skeleton with a guarded remote/API harness.

The harness exercises already-shipped automation execution paths only:

- `record.created` trigger
- `update_record`
- `send_email`
- `send_webhook`
- automation execution-log persistence
- controlled failure handling

No product runtime code, DB schema, migration, K3 PoC adapter, or AI
surface is changed.

## Design

`scripts/ops/multitable-automation-soak.mjs` is blocked by default.
It requires:

- `API_BASE`
- `AUTH_TOKEN`
- `MULTITABLE_AUTOMATION_SOAK_CONFIRM=1`
- `MULTITABLE_AUTOMATION_SOAK_EMAIL_SAFE_MODE=mock`
- `MULTITABLE_AUTOMATION_SOAK_WEBHOOK_URL`
- `MULTITABLE_AUTOMATION_SOAK_FAIL_WEBHOOK_URL`

Optional knobs:

- `MULTITABLE_AUTOMATION_SOAK_ITERATIONS`, default `3`, clamped to
  `1..10`
- `POLL_TIMEOUT_MS`, default `15000`
- `POLL_INTERVAL_MS`, default `1000`
- `AUTOMATION_SOAK_OUTPUT_DIR`
- `AUTOMATION_SOAK_JSON`
- `AUTOMATION_SOAK_MD`

When configured, the harness creates a fresh base/sheet, adds fields,
creates four automation rules, creates N records, and polls execution
logs for each rule.

## Rule Matrix

| Rule | Expected status | Validation |
| --- | --- | --- |
| `record.created -> update_record` | success | every created record is read back with `Status=soaked` |
| `record.created -> send_email` | success | step output has `recipientCount=2` and `notificationStatus=sent` |
| `record.created -> send_webhook` | success | step output has a 2xx `httpStatus` |
| `record.created -> send_webhook` expected failure | failed | execution and first step are persisted as failed with an error |

The expected-failure webhook is intentionally part of the passing
gate. It proves that automation failures are not swallowed and that
the execution log records the failed step.

## Release Gate Wiring

`package.json` now points:

```bash
pnpm verify:multitable-automation:soak
```

to the new harness. The Phase 3 aggregate runner delegates
`automation:soak` to that package script and records the child report
path under:

```text
children/automation-soak/automation-soak/report.{json,md}
```

`release:phase3` still returns BLOCKED when any child is blocked.
After this slice, D2 and D3 remain the intentional blockers under the
K3 stage-1 lock.

## Safety

- The default path sends no webhook and no email.
- `send_email` requires an explicit `mock` safe-mode acknowledgement
  and uses `@test.local` recipients.
- Webhook URLs are operator-provided controlled sinks and are passed
  only to the deployed backend when the gate is explicitly confirmed.
- Reports use the shared Phase 3 redaction writer.
