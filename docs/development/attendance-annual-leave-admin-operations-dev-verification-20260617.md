# Annual-leave admin operations (L5c) — development + verification closeout

**Status:** L5c **slice** closeout. This records the L5c admin-operations UI as built and verified. It is **not** the
whole annual-leave engine's final capstone — the engine track flips to ✅ only after the **L6 staging smoke** passes
on a live stack (see the merged L6 runbook). Authority: the merged L5c design-lock
(`attendance-annual-leave-admin-operations-design-lock-20260617.md`, #2795) + the dev-plan (#2826).

## 1. What shipped (one PR)

One new admin nav section — **年假操作 / Annual leave operations** — the 3rd item in the existing 年假/法定假 group
(no new group; anchor-nav `29 → 30`). It puts the three already-existing, `attendance:admin`-gated, balance-mutating
endpoints behind buttons, each satisfying the five locked dimensions (preview / confirm / idempotency / failure-code
/ permission-audit) — **without flattening the three different back-ends**:

- **Manual adjustment** — `POST /api/attendance/annual-leave-manual-adjustment`.
- **Expiry backfill** — `POST /api/attendance/annual-leave-expiry-backfill`.
- **Accrual run** — `POST /api/attendance/annual-leave-accrual/run`.

Read+config (L5a/L5b) already shipped; this is the mutating-operations layer the L5 design-lock deferred.

## 2. The load-bearing distinction, as built

**Dry-run is not one capability.** Accrual and backfill have a **server dry-run** (the backend returns an
authoritative preview without mutating). Manual adjustment has **no server dry-run** — its "preview" is a
**client-side** computation of `current → resulting` from the L5a balance read, explicitly labelled advisory, with
the **backend `422 ANNUAL_LEAVE_BALANCE_INSUFFICIENT` as the final authority** on a save. The two are kept in
separate code paths and separate UI copy; the client preview is never labelled a "dry-run".

Likewise the **result shapes differ and are never flattened**: accrual `skipReasons` and backfill `reasons` render as
a **code → count table** (they are object maps); manual adjustment returns `{ id, delta, applied, alreadyApplied }`
and is rendered as discrete fields + badges, never routed through the reasons table.

## 3. Per-card 口径 as built

**Manual adjustment (client preview).** Inputs userId / deltaMinutes (±) / reason; a **Preview** computes
before→after from the L5a read; **Adjust balance** opens the in-DOM confirm restating the request; on confirm the POST
carries a per-attempt **idempotency key** (so a double-submit is a server no-op). The result surfaces the returned
**adjustment `id`** and an `Applied` / `Already applied (no change)` badge. `runId` is **scoped out of v1** (standalone
adjustments), so `ANNUAL_LEAVE_ADJUST_RUN_NOT_FOUND` is unreachable from the card and is not in its rendered codes.

**Expiry backfill (server dry-run).** **Dry-run** posts `{dryRun:true}` and renders the `{scanned, updated, skipped}`
counts + the **reasons code→count table** (`ALREADY_SET` framed as a concurrent-write no-op, not a failure);
**Commit backfill** opens the confirm restating the dry-run counts, then posts `{dryRun:false}`.

**Accrual run (server dry-run + period guardrail).** Inputs period (year) / optional as-of; **Dry-run** posts
`{period, dryRun:true}` → summary + `skipReasons` table; **Commit accrual** opens the confirm restating the dry-run
numbers. When the period is **not the current or next year**, the confirm requires an **extra explicit checkbox**
(拍板 C — soft-warn, *not* a hard block). The committed result surfaces `runId` + `periodKey` (provenance). The
commit is **disabled when the policy is off** (load-bearing — the backend `422`s `ANNUAL_LEAVE_NOT_ENABLED`).

## 4. Shared scaffold

- **In-DOM confirm panel** (`role="dialog"`, real overlay) that restates the resolved request as a table — *not*
  `window.confirm` (which cannot show a structured restatement). The confirm is **authoritative**: it consumes a
  **snapshot** of the request captured when it opened, so editing an input while the panel is open cannot change what
  is submitted (see §6 review trail — this was hardened after review).
- **`annualOpsErrorLine(code)`** — one mapper from the real per-endpoint error codes to human lines, with a fallback.
- **`annualOpsPost(path, body, fallback)`** — shared POST that pins `orgId` in the body (so the write lands in the
  current org via `getOrgId` precedence) and surfaces structured `error.code`s; routes `403 → adminForbidden`.
- **`annualOpsPolicyEnabled`** — computed off `annualPolicyForm.enabled`, hydrated first-screen via
  `loadSettings → applyAnnualPolicyToForm`; load-bearing disable on the accrual commit, informational hint elsewhere.

## 5. Symbols + stable selectors (for L6 + future reference)

Section id `attendance-admin-annual-leave-operations` (rail: `ATTENDANCE_ADMIN_SECTION_IDS.annualLeaveOperations`).
Cards: `[data-annual-ops-card="adjust|backfill|accrual"]`; results `[data-annual-ops-result-*]`; errors
`[data-annual-ops-error-*]`; confirm panel `[data-annual-ops-confirm]` + submit `[data-annual-ops-confirm-submit]`;
off-year extra confirm `[data-annual-ops-extra-confirm]`; policy-off hint `[data-annual-ops-policy-off]`.

## 6. Verification

- **`vue-tsc -b`** (project-references build, not `--noEmit`): **0 errors**.
- **Local vitest**: `attendance-admin-regressions` + `attendance-admin-anchor-nav` → **119 passed**. New tests:
  manual-adjust (preview → in-DOM confirm → POST body incl. idempotency key → result id); backfill (dry-run code→count
  table → commit `dryRun:false`); accrual off-year (extra-confirm gating + `skipReasons` table); policy-off accrual
  disable; **TOCTOU snapshot** (tamper the period while the confirm is open → the POST carries the snapshot, not the
  tampered value); error-code → human-line mapping.
- **attendance-web-guard**: anchor-nav `29 → 30` on both literals (`groupLabels` unchanged at 6).

### Adversarial review trail (honest)

Two independent adversarial reviewers checked the build against the backend on `main`. The five named classes
(contract accuracy, anti-flatten, `orgId` routing, failure-surface, idempotency legibility) and RBAC / gate
placement / two-step structure / numeric+idempotency safety / test wire-honesty were all **clean**. Both reviewers
independently caught one real **P2** on the highest-stakes card: the confirm re-read the **live form** on submit and
the modal had **no CSS** (rendered inline, the form still interactive underneath) — so editing the period after the
panel opened could fire a **never-previewed** accrual with the off-year guard bypassed. **Fixed:** `submit*` now
consumes a snapshot taken at confirm-open time; a watch invalidates a stale dry-run on any period/as-of edit; the
modal is a real fixed overlay. P3s (a dead error-code mapper entry; an untested mapper) were also fixed. The passing
tests had missed the P2 because they dry-ran and committed the same period — the lesson logged is that the build's own
tests can pass against a real safety hole, so the adversarial pass + the new TOCTOU test were necessary.

## 7. L6-readiness handoff

The L6 staging smoke (owner-run, per the merged runbook) can now drive these buttons end-to-end: enable the policy
(L5b) → accrual **Dry-run** then **Commit accrual** (server dry-run residue + real grant + idempotent re-run) →
**Manual adjustment** (write + idempotency replay) → backfill **Dry-run** → and the L1 reaper via the scheduler. The
runbook's `user_orgs` single-member-org gate and residue=0 teardown remain the L6 owner's responsibility.

## 8. Out of scope / deferred

- **Employee `/me` self-service balance view** — a separate future endpoint (subject locked to the token), per the L5
  design-lock; never mixed into this admin surface.
- **`runId`-linked corrections** in the adjust card — API-only for now; a small additive input later (re-open the
  design-lock first).
- **A full audit-history viewer** — out of v1; each card surfaces its returned identifiers (adjustment `id`, run
  `runId`/`periodKey`) inline.
