# Data Factory — DF-N1.5 Dead-Letter Replay Design - 2026-05-26

## Status / purpose

**Front-end-only slice adding a single, manual dead-letter replay action** to the Data Factory 运行监控 panel, surfacing the **already-implemented** `POST /api/integration/dead-letters/:id/replay` route. Split out of DF-N1 (read-only monitoring, **merged as #1848**) per review, because replay **re-runs the pipeline — a real target/ERP write** — and its safety semantics deserve to be the *primary* review subject rather than a footnote in a "monitoring" slice.

**This is NOT DF-N3.** It adds one manual, confirm-gated, one-record re-enqueue. It adds **no** bulk retry, stop rules, run policy, back-pressure, or auto-re-enqueue — all of which remain DF-N3 (frozen).

## Relationship to the family

- Builds directly on **#1848** (DF-N1 read-only 运行监控, merged) — reuses its run/dead-letter surfaces.
- **#1844** Stage 5 lists *"retry of selected failed rows"*; this delivers the **single-manual** grain of that, deferring "selected rows"/bulk to DF-N3.
- **#1839** DF-N3 ("Retry and back pressure") owns the orchestration; this slice deliberately stays on the DF-N1 side (surface an existing capability, no new runtime).
- Backend route + `runner.replayDeadLetter` already exist and are tested in `plugins/plugin-integration-core` — **no backend change here.**

## What this slice adds (front-end only)

- `apps/web/src/services/integration/workbench.ts`: `replayIntegrationDeadLetter()` (wraps the existing `POST …/:id/replay`), `isDeadLetterReplayable()` (`status === 'open'`), and the `IntegrationDeadLetterReplayPayload` / `IntegrationDeadLetterReplayResult` types.
- `apps/web/src/views/IntegrationWorkbenchView.vue`: a **retryability badge** + a **two-step confirm** replay control (`准备 Replay → 确认 Replay（会真实写入）`, `取消`) on each **open** dead-letter; on completion it refreshes the monitoring panel.

## PRIMARY REVIEW SUBJECTS (threat model)

Per maintainer direction, these four are the focus of this PR. Each row = the risk, the defense, where it is enforced, and the locking test.

### 1. Idempotency
- **Risk:** replaying re-sends the same source record to the target → a duplicate business object.
- **Defense:** replay re-runs the pipeline with the **stored source payload**, so it carries the same `idempotencyKeyFields` → the pipeline/target dedupes on the idempotency key. This is a **backend invariant** (the pipeline runner + adapter), relied upon here — not re-implemented in the UI.
- **Enforced:** backend (pipeline idempotency key). **UI role:** none beyond not mangling the payload (it sends only `{tenantId, workspaceId, mode}` + the `:id`; the payload is server-held).
- **Note for reviewer:** the strength of this guarantee == the target adapter's idempotency honoring. For K3 this is the idempotency-key contract; confirm it holds for any future target before enabling replay there.

### 2. Duplicate-write risk (UI-side defenses, layered)
- **Risk:** a second live write from accidental / repeated / stale triggering.
- **Defenses:**
  - **Only-open** — `isDeadLetterReplayable` renders the action only for `status === 'open'`; the backend independently throws if status ≠ open (`pipeline-runner.cjs:699`). A letter marked `replayed` after a successful write **cannot be replayed again**.
  - **Two-step confirm** — see §4.
  - **In-flight lock** — `replayingDeadLetterId` disables the confirm button while the request is outstanding (no double-submit).
  - **Success verdict = `rowsFailed` only** — a write that succeeded but whose `markReplayed` bookkeeping failed (letter stays `open` + `warning`, `pipeline-runner.cjs:732-756`) reads as **success**, so the user is **not** prompted to retry a write that already landed.
- **Enforced:** UI (only-open render, confirm, in-flight lock, verdict) + backend (open-only throw, idempotency).
- **Tests:** `does not offer replay for a non-open … dead-letter`; the warning-case verdict test; the two-step-confirm test.

### 3. Permission
- **Risk:** a read-only user triggering a write.
- **Defense:** the route enforces `requireAccess(req, 'write')` server-side → `403` for unauthorized callers. The UI surfaces the error via the status banner; the letter remains visible because the panel is **refresh-driven (server truth)** with no optimistic mutation.
- **Enforced:** backend (authoritative). UI surfaces, does not gate (a client-side hide would be advisory only and could drift from the real grant).
- **Tests:** service `surfaces a 403 when the caller lacks write permission`; component `surfaces a 403 permission error on replay without removing the dead-letter`.

### 4. Two-step confirm
- **Risk:** a single stray click firing a live write.
- **Defense:** `准备 Replay` only arms the confirm; the **first click issues no network call**; only `确认 Replay（会真实写入）` POSTs. Mirrors the existing Save-only `allowSaveOnlyRun` posture.
- **Enforced:** UI.
- **Test:** the two-step-confirm test asserts the prepare click issues **zero** `apiFetch` to `/replay`.

## Boundaries / non-goals

- **Front-end only.** Touches `apps/web/**` + these docs. No backend / migration / connector / OpenAPI / RBAC change (the route already exists). K3 Stage-1 lock respected.
- **Single manual** replay only — **no** bulk "retry selected rows", stop rules, run policy, back-pressure, auto-re-enqueue (DF-N3, frozen).
- No change to DF-N1's read-only surfaces; this strictly *adds* the action.

## Test plan

- **Service** (`integrationWorkbench.spec.ts`): replay route/body/encoding; `isDeadLetterReplayable` truth table; **501** and **403** error surfacing.
- **Component** (`IntegrationWorkbenchView.spec.ts`): two-step confirm (prepare ⇒ no POST); confirm POSTs scoped body ⇒ observation reload; markReplayed-warning ⇒ success (no false retry); non-open ⇒ no replay button; **403 ⇒ error surfaced, letter retained**.

## See also

- #1848 (DF-N1 read-only monitoring, merged) · #1839 (DF-N phasing; DF-N3 = bulk retry/back-pressure) · #1844 (IA Stage 5) · #1838 (direction/gating).
- Backend: `plugins/plugin-integration-core/lib/pipeline-runner.cjs` (`replayDeadLetter`, lines ~688–757) · `lib/http-routes.cjs` (`deadLettersReplay`).
- Verification: `data-factory-df-n1_5-deadletter-replay-verification-20260526.md`.
