# Data Factory — DF-N1.5 Dead-Letter Replay Verification - 2026-05-26

Verification for `data-factory-df-n1_5-deadletter-replay-design-20260526.md`. Branch `frontend/data-factory-df-n1_5-deadletter-replay-impl-20260526` (off `origin/main` @ `be87b4d96`, i.e. on top of merged DF-N1 #1848). **Front-end only; not merged — held for review** (the four threat-model subjects below are the intended review focus).

## What was implemented

| File | Change |
|---|---|
| `apps/web/src/services/integration/workbench.ts` | `replayIntegrationDeadLetter()` over the existing `POST /api/integration/dead-letters/:id/replay`; `isDeadLetterReplayable()` (`status==='open'`); `IntegrationDeadLetterReplay{Payload,Result}` types. |
| `apps/web/src/views/IntegrationWorkbenchView.vue` | Per open dead-letter: retryability badge + **two-step confirm** replay (`准备 → 确认（会真实写入）`, `取消`), in-flight lock, success verdict = `rowsFailed` only; refresh on completion. |
| `apps/web/tests/integrationWorkbench.spec.ts` | Replay route/body/encoding; `isDeadLetterReplayable` truth table; **501** + **403** surfacing. |
| `apps/web/tests/IntegrationWorkbenchView.spec.ts` | Two-step confirm (prepare⇒no POST); confirm⇒POST⇒reload; markReplayed-warning⇒success; non-open⇒no button; 403⇒error surfaced + letter retained; in-flight⇒confirm disabled + busy label (no double-submit window). |
| `docs/development/data-factory-df-n1_5-deadletter-replay-{design,verification}-20260526.md` | This design + verification. |

## Threat-model subjects → evidence

| Subject | Where enforced | Locking test |
|---|---|---|
| **Idempotency** | backend (pipeline idempotency key on replay re-run) | n/a in FE — documented invariant; UI sends only id+scope, not payload |
| **Duplicate-write** | UI (only-open render, two-step confirm, in-flight lock, `rowsFailed` verdict) + backend (open-only throw, idempotency) | `does not offer replay for a non-open … dead-letter`; markReplayed-warning⇒success; two-step confirm; `locks the confirm button while a replay is in flight` |
| **Permission** | backend `requireAccess(req,'write')` ⇒ 403 | service `surfaces a 403 …`; component `surfaces a 403 … without removing the dead-letter` |
| **Two-step confirm** | UI | prepare click issues **zero** `/replay` POST; only confirm POSTs |

## Commands run (from the worktree)

```
pnpm --filter @metasheet/web exec vitest run tests/integrationWorkbench.spec.ts tests/IntegrationWorkbenchView.spec.ts
  → Test Files 2 passed (2) · Tests 40 passed (40)   (service 28, component 12)
pnpm --filter @metasheet/web type-check          → exit 0 (vue-tsc -b, no errors)
pnpm --filter @metasheet/web exec eslint <4 changed files>
  → 0 errors, warnings = pre-existing `router-link` test-stub pattern only
```

## Lock-profile confirmation

- **Pure front-end.** Diff is `apps/web/**` (view + service + specs) + these two docs only. **No** change to `plugins/plugin-integration-core/**`, `packages/core-backend/**`, migrations, OpenAPI, RBAC, or any connector — the replay **route already exists**; this only surfaces it. K3 Stage-1 lock respected. (The `node_modules/.bin` churn from the worktree `pnpm install` is **not** staged.)
- **Single manual** replay only; no bulk/stop-rules/back-pressure/auto-re-enqueue (DF-N3 stays frozen).
- Construction note: the replay delta was reconstructed as `diff(merged-main, the preserved df-n1_5 commit d39c6f934)` restricted to source+test files (verified to be purely the replay additions), then re-applied on top of `be87b4d96`; DF-N1.5 docs are written fresh (not carried from the old DF-N1 draft).

## Not done (still separate gated opt-ins)

DF-N2 provenance events · DF-N3 bulk retry / stop rules / run policy / back-pressure · DF-N4 connector catalog · cross-pipeline monitoring · K3 Submit/Audit/BOM/multi-record/read-unlock.
