# Automation Execution Log JSONB Fix — Development

Date: 2026-05-08
Branch: `codex/automation-log-jsonb-fix-20260508`

## Context

After the `send_email` action CHECK constraint migration landed, the RC staging harness progressed further:

1. `POST /automations` accepted `send_email`.
2. A real `record.created` event triggered the automation executor.
3. `AutomationLogService.record()` attempted to insert the execution log.
4. PostgreSQL rejected the `steps` JSONB value with `22P02 invalid input syntax for type json`.
5. Because `executeRule()` did not await or catch `logService.record()`, the rejection escaped as an unhandled async failure and restarted the backend process.

## Root Cause

`AutomationLogService.record()` passed `execution.steps` directly as a JavaScript array:

```ts
steps: execution.steps as unknown as Record<string, unknown>[]
```

For PostgreSQL parameters, object values are JSON-stringified by `pg`, but JavaScript arrays are treated as PostgreSQL array literals. That produces a value shaped like an array of escaped JSON object strings, not a JSONB array.

The failure suffix seen on staging:

```text
... "durationMs":205}"}\n
```

matches that array-literal double-encoding path.

## Change

Two changes were made:

1. `AutomationLogService.record()` now writes `steps` through `toJsonValue(execution.steps)`, which emits an explicit `::jsonb` cast from a JSON string.
2. `AutomationService.executeRule()` now awaits `logService.record(execution)` and catches persistence failures, logging them instead of letting a rejected promise crash the process.

This preserves the execution result contract while preventing automation log persistence from becoming a process-level failure.

## Risk Notes

This fix is intentionally narrow:

- It does not change automation action execution.
- It does not change notification sending.
- It does not change the automation log schema.
- It does make execution logging deterministic for callers because `executeRule()` now waits for the log attempt to finish.

The RC staging harness should be rerun after deployment because this fix targets the exact second `automation-email` blocker.
