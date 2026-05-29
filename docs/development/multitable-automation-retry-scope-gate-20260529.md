# Multitable Automation Retry Scope Gate (A4) — 2026-05-29

Status: design-only scope gate / scout complete; consumed by A5 runtime (#2047)
Scope: `POST /api/multitable/automation-executions/:id/retry` planning only
Runtime: implemented later by #2047; response hardening by #2051/#2053
Companion: `docs/development/run-governance-forward-plan-20260528.md`

## Verdict

Automation retry can proceed only as a separately named A5 runtime unlock. This
A4 document itself did not add runtime, route, migration, UI, or retry behavior;
that later happened through the explicit A5 unlock in #2047.

The key design constraint is that A1 deliberately persists redacted execution
snapshots. Therefore A5 must not blindly replay the stored `rule_snapshot` for
secret-bearing actions. The stored snapshot is good for diagnosis and most
business context, but auth headers, webhook URLs, tokens, cookies, SMTP secrets,
and similar values may be scrubbed before persistence.

Recommended A5 direction:

- Retry from the stored execution's redacted `trigger_event`.
- Use the current enabled automation rule as the executable source.
- Require an operator confirmation that retry may re-run side effects.
- Link attempts with `rerun_of_execution_id` and record `initiated_by`.
- Reject success/running executions.
- Treat secret-bearing snapshot replay as unsupported unless a future encrypted
  retry snapshot is explicitly designed.

## Grounding

At A4 authoring time, code on `origin/main` supported planning but not A5
runtime:

- `AutomationExecutor.execute()` captures `triggerEvent` and `ruleSnapshot` on
  the in-memory execution object before persistence.
- `AutomationLogService.record()` redacts all four free-form channels before DB
  insert: `steps`, `trigger_event`, `rule_snapshot`, and execution-level
  `error`.
- `automation-log-redact.ts` masks secret/auth-shaped structured keys and
  secret-shaped strings; contact/PII masking is intentionally deferred.
- `routes/automation.ts` exposes only read-only run list/detail routes under
  `requireAdminRole()`.
- There is no automation retry route, no `rerun_of_execution_id`, no
  `initiated_by` on `multitable_automation_executions`, and no persistent
  automation job runtime.

Post-GATE context: the global K3 Stage-1 lock is retired for planning purposes,
but this does not authorize automatic runtime expansion. A5 is still a named
runtime unlock because it can duplicate external side effects.

## A4 Decisions

### D1 — Retry Source

Use **current enabled rule + stored trigger event** for A5 v1.

Rationale:

- The current rule path preserves live credentials and current connector /
  webhook configuration.
- The stored `trigger_event` preserves the original record context and actor
  context as captured by A1.
- Stored `rule_snapshot` is redacted before persistence and cannot be treated as
  an executable credential source.

Explicit non-goals:

- Do not execute a persisted redacted `rule_snapshot`.
- Do not persist raw secrets for retry in A5 v1.
- Do not build encrypted raw retry snapshots in A5 v1.

### D2 — Allowed Source Executions

A5 v1 may retry only terminal non-success executions:

- allowed: `failed`, `skipped`
- rejected: `success`, `running`

`skipped` is allowed because conditions may have changed in the current rule, but
the retry response must make clear that it is a new execution, not a mutation of
the original run.

### D3 — Permission

Retry remains platform-admin only.

A2/A3 already made cross-sheet run governance admin-only. A5 should reuse the
same `requireAdminRole()` posture unless a later product decision introduces
per-sheet automation administration.

### D4 — Side-effect Confirmation

A5 must require an explicit operator confirmation flag for any retry request,
for example:

```json
{ "confirmSideEffects": true }
```

Reason: current automation actions include writes and external effects:

- `update_record`
- `create_record`
- `send_webhook`
- `send_notification`
- `send_email`
- `send_dingtalk_group_message`
- `send_dingtalk_person_message`
- `lock_record`

Retry is not a harmless read operation.

### D5 — Idempotency

A5 v1 should record provenance but should not promise exactly-once delivery.

Minimum acceptable provenance:

- `rerun_of_execution_id`
- `initiated_by`
- new execution id
- original execution remains immutable

If A5 later supports external idempotency keys, that is a follow-up design,
especially for webhook/email/DingTalk actions.

### D6 — Snapshot Exposure and PII

Do not broaden PII masking in A5 v1.

A1 intentionally preserves business field values for diagnosis while scrubbing
secret-shaped values. A5 should not silently change that storage/read behavior.
If replay UI needs additional PII masking, gate it as a UI/display policy, not as
a storage rewrite.

### D7 — Failure Mode for Redacted / Missing Inputs

A5 must fail closed when a retry cannot be reconstructed:

- original execution missing -> 404
- original execution status not retryable -> 409
- current rule missing or disabled -> 409
- stored trigger event missing or invalid -> 409
- service unavailable -> 503, consistent with A2

Do not silently fall back to empty `{}` trigger data.

### D8 — WorkflowJob / A6 Boundary

A5 should continue to emit the same legacy execution storage shape and let A2 map
it to C1 at the read boundary.

Do not add persistent `WorkflowJob` storage, suspend descriptors, branch graph
fields, `automation_jobs`, or BPMN/approval bridges in A5. Retry is a whole-run
rerun, not the convergence engine.

## A5 Minimal Implementation Shape (Future Unlock)

> Closeout note (2026-05-29): A5 was unlocked and implemented by #2047 using
> this design's current-rule + stored-trigger-event direction. #2051/#2053 then
> closed the `/test` and retry response-redaction / log-read fail-open
> hardening. The implementation did not unlock A6.

Files likely touched by A5:

- `packages/core-backend/src/multitable/automation-log-service.ts`
  - add `getRetryCandidate(id)` or reuse `getById()`
  - include new columns in mapper after migration
- `packages/core-backend/src/multitable/automation-service.ts`
  - add `retryExecution(executionId, initiatedBy, options)`
  - load current enabled rule
  - validate original run status and trigger snapshot
  - call `executeRule()` with original trigger event plus retry metadata
- `packages/core-backend/src/routes/automation.ts`
  - add admin-only `POST /automation-executions/:executionId/retry`
  - validate `confirmSideEffects === true`
- `packages/core-backend/src/db/migrations/zzzz20260529*_automation_retry_attempt_fields.ts`
  - add nullable `rerun_of_execution_id`
  - add nullable `initiated_by`
- `packages/core-backend/tests/unit/automation-runs-api.test.ts`
  - route permissions, status rejection, missing run/rule cases
- `packages/core-backend/tests/unit/automation-v1.test.ts`
  - execution linkage and trigger reuse

No frontend retry button in A5 unless the backend route, provenance, and tests are
already landed. A3 can continue to display runs read-only.

## A5 Test Matrix (Future Unlock)

Required tests before A5 can merge:

- failed execution retry creates a new execution id and leaves original unchanged
- skipped execution retry creates a new execution id
- success execution retry returns 409
- running execution retry returns 409
- missing execution returns 404
- current rule missing/disabled returns 409
- missing or invalid trigger snapshot returns 409
- retry route is gated by `requireAdminRole()`
- `confirmSideEffects !== true` returns 400/409
- new execution stores `rerun_of_execution_id` and `initiated_by`
- retry uses current rule rather than persisted redacted rule snapshot
- redacted snapshot remains redacted in read API

Recommended focused commands:

```bash
pnpm --filter @metasheet/core-backend exec vitest run --watch=false \
  tests/unit/automation-runs-api.test.ts \
  tests/unit/automation-v1.test.ts \
  tests/unit/workflow-job-contract.test.ts
pnpm --filter @metasheet/core-backend build
```

## Hard No for A5

A5 must not:

- introduce `automation_jobs`
- add suspend/resume
- add branch/parallel graph fields
- add BPMN compile/preview adapter
- add `start_approval`
- retry K3 writes automatically
- store raw secrets without a separate encrypted snapshot design
- convert legacy execution storage to C1 `WorkflowJob` storage

## Re-entry Rule

A5 may start only after an explicit owner signal such as:

> start A5 whole-execution retry runtime, using current enabled rule + stored
> trigger event, admin-only, with side-effect confirmation.

Without that signal, this A4 scope gate remains a planning artifact and runtime
stays closed.
