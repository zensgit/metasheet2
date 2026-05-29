# Multitable Automation A5 — Whole-execution Retry Runtime (verification) — 2026-05-29

- **Slice**: A5 — runtime for `POST /api/multitable/automation-executions/:executionId/retry`. Implements the A4 scope-gate `multitable-automation-retry-scope-gate-20260529.md` (#2039). Owner opt-in given 2026-05-29 ("start A5 whole-execution retry runtime, current enabled rule + stored trigger event, admin-only, side-effect confirmation").
- **Status**: ✅ implemented + verified (this doc). A6 convergence engine remains frozen / demand-gated.
- **Grounding**: worktree off `origin/main`. Automation is multitable-kernel (never `integration-core`); post-GATE the K3 Stage-1 blanket lock is retired (#1993), but A5 is gated by its own named opt-in (retry re-runs external side effects).

## What shipped

| File | Change |
|---|---|
| `db/migrations/zzzz20260529120000_…retry_attempt_fields.ts` | ADD COLUMN IF NOT EXISTS `rerun_of_execution_id TEXT`, `initiated_by TEXT` (both nullable). |
| `db/types.ts` | 2 nullable columns on `MultitableAutomationExecutionsTable`. |
| `automation-executor.ts` | `AutomationExecution` += `rerunOfExecutionId?` / `initiatedBy?` (plain ids; not redacted). |
| `automation-log-service.ts` | `record()` persists the 2 columns (no redaction — identifiers); `toExecution` maps them back null-safe. |
| `automation-service.ts` | `executeRule(rule, triggerEvent, retryMeta?)` stamps provenance before persist; new `retryExecution(executionId, initiatedBy)` (discriminated result). |
| `routes/automation.ts` | `POST /automation-executions/:id/retry` (admin-only); serializes the **persisted (redacted) row** via `getById` re-fetch — NOT the raw in-memory execution (see Security note). `toRunView` surfaces `rerunOfExecutionId`/`initiatedBy` (list + detail). |
| tests | `automation-v1` (retryExecution orchestration ×9), `automation-runs-api` (route ×3 + detail provenance + guard-count 3), `tests/integration/multitable-automation-retry.test.ts` (real-DB column round-trip) + wired into `plugin-tests.yml`. |

## A4 design decisions → implementation

| A4 (#2039) | Implemented |
|---|---|
| **D1** current enabled rule + stored trigger_event; never replay redacted `rule_snapshot` | `retryExecution` loads `getRule(original.ruleId)` (live creds) + reuses `original.triggerEvent`; never reads `ruleSnapshot`. Test: "uses CURRENT rule (live token), never the redacted snapshot". |
| **D2** retry `failed`/`skipped`; reject `success`/`running` | status check → 409 NOT_RETRYABLE. `skipped` retryable (current rule's conditions may now pass). |
| **D3** admin-only | route `requireAdminRole()` (same posture as A2/A3, #1973). |
| **D4** side-effect confirmation | route requires `confirmSideEffects === true` → else 400; lists the side-effecting actions in #2039. |
| **D5** provenance, not exactly-once | `rerun_of_execution_id` + `initiated_by` + new execution id; original immutable. No idempotency-key promise (follow-up). |
| **D6** don't broaden PII masking | A1 redaction unchanged; no new masking. |
| **D7** fail-closed | 404 missing / 409 not-retryable / 409 missing-trigger-event / 409 rule-missing-or-disabled / 503 service-down. `isRetryableStoredTriggerEvent` requires a **non-empty plain object** — rejects null / array / `{}` so the executor's `recordId ?? '' / recordData ?? {}` fallback can NEVER silent-retry with empty context (a record-less `{_triggeredBy:'schedule'}` is still valid). No silent `{}`. |
| **D8** A5 ≠ A6 | legacy execution storage shape; A2 maps to C1 at read. NO WorkflowJob storage / suspend / branch / automation_jobs / BPMN / approval bridge. |

## ⚠️ Known limitation (owner-visible) — redacted record fields in the replayed trigger_event

A1 redacts `trigger_event` **including the record `data` map** before persist (secret-shaped values + secret/auth structured keys → `<redacted>`). A5-D1 locked "replay the stored trigger_event", so on retry a record field that was secret-shaped (e.g. a field literally named `token`/`password`, or a token-shaped value) replays into `context.recordData` as `<redacted>` — which feeds both `evaluateConditions(...)` and action execution. A condition could branch differently, or an `update_record`/`send_webhook` could write the literal `<redacted>`.

This is **inherent to D1's choice** (the rejected alternatives were re-fetching the live record or storing raw secrets). **Accepted for A5 v1**: credentials come from the current rule (correct); business record fields are preserved by A1 (only secret-shaped ones are scrubbed, which is rare in record data). Pinned by a test ("redacted field inside the stored trigger_event replays deterministically (no crash)"). If this becomes a real problem, a future opt-in could re-fetch the current record for retry context — a separate design.

## Security note — the retry response must NOT serialize the raw in-memory execution

The new execution built by `executor.execute` carries `ruleSnapshot = the current rule` (**LIVE credentials**) and `steps` with raw action output (responseBody/error). `record()`'s `redactValue` returns NEW objects — it scrubs the DB row but does **not** mutate the in-memory execution. A2 read paths read from the DB (redacted), so the A1 at-persist-redaction invariant held — but the retry route is the first place an in-memory (raw) execution could be serialized to HTTP. **Fix: the route re-fetches the persisted (redacted) row via `getById` and serializes that** (response == stored, same contract as the detail GET). If persistence was swallowed (record() is fire-and-forget), it returns a minimal safe body (ids/status only — no `steps`/`ruleSnapshot`). Two route tests pin this (secret-bearing raw execution → response contains none of it; null persisted → minimal safe body). Caught in review; the no-secret fixture had hidden it.

## Verification

- `tsc --noEmit` (core-backend): ✅ 0 errors.
- Unit: ✅ **167** (`automation-v1` retryExecution: 404 / 409-not-retryable / **409-missing-trigger fail-closed {} | [] | non-object → no getRule/executeRule** / record-less-schedule-trigger-retryable / 409-rule-disabled / delegate-with-provenance / D1-current-rule / redacted-passthrough / skipped-retryable; `automation-runs-api` retry route: **no-secret-leak (serialize persisted-redacted)** + safe-fallback + confirmSideEffects-400 + 409-mapping + initiatedBy→provenance('admin1') + detail provenance + guard-count=3; `automation-routes-wiring` unchanged).
- Real-DB round-trip: `tests/integration/multitable-automation-retry.test.ts` (describeIfDatabase + sentinel) — `record()` writes + `getById()` maps + raw-SQL confirms the 2 columns; wired into `plugin-tests.yml` real-DB job (hard-guard on DATABASE_URL).
- ESLint (my changed files): clean. One **pre-existing** `prefer-const` on `let actions` in `parseCreateRuleInput` (origin/main, unrelated function, not introduced here; core-backend has no `lint` script so CI does not flag it) — **left as-is** (scope discipline; not an A5 regression).

## Out of scope / follow-ups (each a separate opt-in)
- **A6** convergence engine (suspend/resume / branch / approval-as-job / BPMN adapter) — frozen / demand-gated.
- Frontend retry button (A3 is read-only; #2039 says no button until backend + provenance + tests land — now they have, so a frontend slice could follow as its own opt-in).
- External idempotency keys for webhook/email/DingTalk retries (#2039 D5 follow-up).
- Re-fetch-current-record retry context (addresses the redacted-trigger limitation) — separate design.
- **PRE-EXISTING (flagged, NOT fixed here):** `POST /sheets/:sheetId/automations/:ruleId/test` (`automation.ts:134`) does `res.json(execution)` on the raw in-memory execution. Since **A1** added `ruleSnapshot` to `AutomationExecution`, that endpoint likely serializes the raw (live-credential) snapshot the same way the retry route would have. This is an A1-era gap, not an A5 regression — out of scope for this PR; recommend a separate fix (re-fetch persisted row, or redact at serialization). Surfaced consciously.
