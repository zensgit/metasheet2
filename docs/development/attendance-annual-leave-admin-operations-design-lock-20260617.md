# Annual-leave admin operations UI — design-lock (L5c)

Status: locked 2026-06-17 (owner 拍板). Follows the completed backend engine L0–L4 and the admin UI L5a (balance read) + L5b (policy config), all on `main`. L5c is the administrator UI for the three **balance-mutating** annual-leave / statutory-annual-leave (年假 / 法定年假) admin actions, which until now have been **API-only**. It does not add or change any backend route; it locks the surface that puts the existing endpoints behind buttons, with dry-run-first, explicit confirmation, an idempotency-result explanation, and a failure-reason surface — the gated work the L5 design-lock deferred to "its own design-lock."

The three endpoints (all `withPermission('attendance:admin')`, org via `getOrgId`) are taken as-is from `plugins/plugin-attendance/index.cjs` on `main`; every field, error code, and summary key below was verified against that source.

## 0. Scope (owner-locked)

Three operation cards ship in **one Operations section, in one PR** (owner 拍板 B):

- **Manual adjustment** — `POST /api/attendance/annual-leave-manual-adjustment` (± a user's balance).
- **Expiry backfill** — `POST /api/attendance/annual-leave-expiry-backfill` (stamp `expires_at` on pre-L4 lots).
- **Accrual run** — `POST /api/attendance/annual-leave-accrual/run` (grant the period's entitlement).

All three live inside **one new admin navigation section** — "年假操作 / Annual leave operations" — nested in the existing 年假 / 法定假 group alongside the L5a Balance and L5b Policy blocks (owner 拍板 A). They are **not** three PRs and **not** stacked (owner 拍板 B): the five locked dimensions (§2) are shared scaffolding instantiated three times, and the single-file component, the nav group, and the anchor-nav literals collide if the work is split. The PR is built **fresh off `origin/main`**.

## 1. Why one section, three cards

The three actions share one operator mental model — *preview, read the result, then commit* — and one substrate: `attendance:admin`, `getOrgId`, and the same `apiFetch` / `apiGet` client. Their **back-ends differ, and the doc must not flatten that**: accrual and manual-adjustment resolve subjects through **active org membership** (`user_orgs uo JOIN users u WHERE uo.org_id=$org AND uo.is_active=true AND u.is_active=true`), whereas expiry-backfill takes **no** `user_orgs` path at all — it scans **org-level `annual_accrual` lots** directly (`WHERE org_id=$org AND leave_type_code='annual' AND source_type='annual_accrual' AND expires_at IS NULL`). The result shapes differ too: accrual (`skipReasons`) and backfill (`reasons`) return a `{ code → count }` map, while manual-adjustment returns `{ id, delta, applied, alreadyApplied }` (no reasons map). Folding them into one section keeps the shared *interaction* model (preview → confirm → result) in one place and lets the cards reuse one confirm/preview/result scaffold — without pretending the three back-ends are one.

## 2. The five locked dimensions, made concrete per card

Every card is built from the same five dimensions. The load-bearing distinction the owner tightened: **dry-run is not one capability.** Accrual and backfill have a **server dry-run** (the backend persists/reads a real preview and returns an authoritative summary without mutating balances). Manual adjustment has **no server dry-run** — its "dry-run-first" is a **client-side preview/confirm only**. The doc keeps these in two separate rows and never presents them as the same thing.

### 2.1 Dimension 1 — Preview (server dry-run vs client preview)

| Card | Preview kind | Mechanism | Authority |
|---|---|---|---|
| Manual adjustment | **Client preview only** | UI computes `current → resulting` from the L5a balance read; for a negative delta, hints available balance from that read | **Backend 422 (FIFO-insufficient) is final.** The client hint is advisory; it is never presented as a server dry-run |
| Expiry backfill | **Server dry-run** | `{ dryRun: true }` → backend returns `{ scanned, updated, skipped, reasons }` with **no** writes | Server summary is authoritative |
| Accrual run | **Server dry-run** | `{ dryRun: true }` → backend persists run + run_items but **no lots/events**, consumes **no** `source_key`, returns the full summary | Server summary is authoritative |

For accrual and backfill the card's default action is the dry-run; the commit button is a second, deliberate step seeded with the dry-run's numbers. For manual adjustment, the "Preview" panel is purely a client-rendered before/after derived from the balance read — labelled as a preview, not a dry-run — and submitting is the only thing that touches the server.

### 2.2 Dimension 2 — Confirm (explicit second step)

Every commit is a two-step confirm. The confirm dialog restates the resolved request (target user / period / delta / dryRun=false) and, for accrual/backfill, the dry-run counts the operator just saw. No card commits on a single click.

### 2.3 Dimension 3 — Idempotency result (explained, not hidden)

Each card surfaces *what idempotency did* so a re-run is legible rather than alarming — see §4 for the per-card 口径. The summary panel names the no-op buckets explicitly (`alreadyGranted`, `alreadyApplied`, `ALREADY_SET`) instead of silently showing "0 changed."

### 2.4 Dimension 4 — Failure-reason surface (real codes + reasons table)

Errors render the **real** endpoint error code (§3), not a generic "failed." The auditable `skipReasons` / `reasons` maps render as a **code → count table** (they are objects/maps, not arrays — §3).

### 2.5 Dimension 5 — Permission / audit provenance

All three are `attendance:admin`-gated server-side; the UI mirrors that with the existing `adminForbidden` gate. Each card makes the provenance visible: manual adjustment captures a required `reason` (1–500) and writes a registry row (who = actor, why = reason) + ledger event; accrual writes a run + run_items the L5a read can later cite; backfill returns a scanned/updated/skipped audit. See §5.

## 3. Failure-code surfacing (verified against `main`)

Render the literal code from `error.code`; map each to a human line. Codes below are exactly those in `plugin-attendance/index.cjs`.

**Manual adjustment** (`POST /api/attendance/annual-leave-manual-adjustment`, body `{ userId, deltaMinutes:int32 nonzero, reason:1-500, idempotencyKey?:1-200, runId?:uuid }`):
- `400 VALIDATION_ERROR` — schema (missing userId / out-of-range deltaMinutes / reason length / etc.).
- `400 ANNUAL_LEAVE_ADJUST_DELTA_INVALID` — `deltaMinutes` is 0.
- `404 USER_NOT_IN_ORG` — target is not an **active** `user_orgs` member of this org (a member with no active row, or a globally-deactivated user, is invisible — same population as accrual).
- `422 ANNUAL_LEAVE_BALANCE_INSUFFICIENT` — negative delta exceeds FIFO-deductible active lots; the whole txn (including the registry row) rolls back. **This 422 is the final authority** the client preview defers to.
- `422 ANNUAL_LEAVE_ADJUST_RUN_NOT_FOUND` — `runId` does not reference a real (non-dry-run) annual run in this org.
- `409 ANNUAL_LEAVE_ADJUST_IDEMPOTENCY_CONFLICT` — same `idempotencyKey` reused with a *different* payload (user/amount/reason/run). Surface as "this idempotency key already names a different adjustment," not a generic conflict.
- `503 DB_NOT_READY` / `500 INTERNAL_ERROR` — infra.

On success the body is `{ id, delta, applied, alreadyApplied }`. `applied:true` = committed; `alreadyApplied:true` (with `applied:false`) = an idempotent replay that re-applied nothing — the card states "already applied (no change)."

**Expiry backfill** (`POST /api/attendance/annual-leave-expiry-backfill`, body `{ dryRun?:bool, orgId?:string }` — backfill is the one of the three whose schema explicitly accepts an optional `orgId`; `getOrgId` resolves the effective org regardless, and the card sends only `dryRun`):
- `400 VALIDATION_ERROR`, `503 DB_NOT_READY`, `500 INTERNAL_ERROR`.
- Success → `{ scanned, updated, skipped, dryRun, reasons }`, where `reasons` is an **object/map** (`reasonCode → count`), not an array. Render as a code → count table. Known reason codes: `NON_ACCRUAL_SOURCE`, `MISSING_RUN_ITEM`, `INVALID_RUN_ITEM`, `MISSING_RUN`, `INVALID_RUN`, `UNPARSEABLE_POLICY_VERSION`, `MISSING_TIMEZONE`, `UNPARSEABLE_PERIOD_KEY`, `ALREADY_SET` (skipped because concurrently set — explicitly an idempotency no-op, not a failure).

**Accrual run** (`POST /api/attendance/annual-leave-accrual/run`, body `{ period:int 2000-2100, asOf?:'YYYY-MM-DD', dryRun?:bool }`):
- `400 VALIDATION_ERROR` — period out of range / malformed asOf.
- `400 ANNUAL_LEAVE_INVALID_ASOF` — asOf not a valid YYYY-MM-DD date.
- `422 ANNUAL_LEAVE_NOT_ENABLED` — `annualLeavePolicy.enabled` is not true (the engine refuses to run; mirrors §6 client gating).
- `422 ANNUAL_LEAVE_TIMEZONE_REQUIRED` / `422 ANNUAL_LEAVE_TIMEZONE_INVALID` — policy timezone unset or not a valid IANA identifier.
- `503 DB_NOT_READY`, `500 INTERNAL_ERROR`.
- Success → `{ runId, periodKey, asOf, dryRun, granted, skipped, grantedMinutes, lotsCreated, alreadyGranted, skipReasons }`, where `skipReasons` is an **object/map** (`reasonCode → count`), not an array — render as a code → count table. Known reason codes are exactly those emitted by `computeAnnualLeaveAccrualForUser` on `main`: `NOT_YET_HIRED`, `HIRED_AFTER_PERIOD`, `MISSING_HIRE_DATE`, `MISSING_SERVICE_START_DATE`, `NOT_ELIGIBLE_UNDER_ONE_YEAR`, `NO_MATCHING_TIER`, `PRORATION_BELOW_ONE_DAY`. The run wrapper can also surface an `UNKNOWN` bucket (a skipped item with a falsy reason), so the card's reason→human-line map **must carry a default/fallback line** rather than hardcoding only the seven — the code→count table already renders an unexpected key gracefully.

In a dry-run, `granted` is the *computed-grantable* count and `lotsCreated`/`alreadyGranted` reflect that nothing was written; in a real run, `lotsCreated` counts new lots and `alreadyGranted` counts source_key no-ops.

## 4. Idempotency 口径 per card

- **Manual adjustment — client-supplied key.** `idempotencyKey` (optional, 1–200) → `source_key = annual_manual_adjust:{key}`; a retry with the *same* payload is a no-op returning `alreadyApplied:true`; a retry with a *different* payload under the same key is a loud `409`. The card offers a stable per-attempt key so an operator's double-submit can't double-adjust, and explains the `409` as a key reuse, not a transient error.
- **Accrual run — natural (org, period) key.** Idempotent by `source_key = annual_accrual:{user}:{period_key}` (`ON CONFLICT DO NOTHING`). Re-running the same period grants nothing new and surfaces `alreadyGranted`. The card states this plainly: a second real run is safe and reports `alreadyGranted` rather than double-granting. (Snapshot limitation: a re-run does **not** top-up a tenure-boundary change — corrections go through manual adjustment. The card links the two.)
- **Expiry backfill — idempotent by nature.** The scan only selects lots `WHERE expires_at IS NULL`, so an already-stamped lot from a prior run **never enters the scan** — it is simply absent, not reported. `ALREADY_SET` is narrower than that: it counts a lot whose `expires_at` was set **concurrently**, between this run's select and its update (a select-then-update race), which is an idempotency no-op, not a failure. Re-running is always safe; the card frames `ALREADY_SET` as a concurrent-write no-op, and a prior-run lot as simply out-of-scope.

## 5. Permission / audit provenance 口径

- **Gate.** All three routes are `withPermission('attendance:admin')`; the UI mirrors with `adminForbidden`. The current admin semantics are global (not per-org-admin scope); the only tenant boundary these endpoints enforce is the **target-membership guard** (manual adjustment's `USER_NOT_IN_ORG`) and org-scoping via `getOrgId` — the cards do not imply a per-org admin role that does not exist.
- **Reason capture.** Manual adjustment requires a `reason` (1–500); the card makes it a required field and shows that it becomes the registry row's *why* (actor = *who*). Accrual/backfill carry no free-text reason; their provenance is the run/scan record.
- **Provenance surfaces.** Accrual returns a `runId` + `periodKey` the L5a balance read can later cite (each annual lot back-links to a run-item); manual adjustment returns the adjustment `id` and writes a ledger event; backfill returns the scanned/updated/skipped audit. Each card shows these so an action is traceable after the fact.

## 6. policy.enabled proactive gating

On `loadSettings`-hydrated `annualLeavePolicy.enabled === false`, the cards are **proactively disabled** with a visible hint pointing at the L5b Policy block, rather than letting an operator submit and bounce off `422 ANNUAL_LEAVE_NOT_ENABLED` (or, for adjustment/backfill, mutate against a disabled-but-still-callable surface). The accrual card's disable is load-bearing (the backend refuses); the adjustment/backfill cards disable for consistency and to steer the operator to enable the policy first. The hint is informational, not a hard client block on top of the server contract.

## 7. Accrual period guardrail (owner 拍板 C)

When the entered `period` is **not** the current or next calendar year, the accrual card **soft-warns and requires an explicit extra confirm** — it does **not** hard-block. Back-dating or far-future accrual is a legitimate (if rare) admin need; the guardrail makes it deliberate, not impossible. The warning text names the off-year period; the confirm dialog restates it.

## 8. Placement + anchor-nav (29 → 30)

The new "年假操作 / Annual leave operations" section is the 30th anchored admin section. Both literals in `apps/web/tests/attendance-admin-anchor-nav.spec.ts` must bump from 29 to 30 **in the same PR**:

- the nav-link assertion — `expect(labels).toHaveLength(29)` → `30`;
- the quick-jump option-count assertion — `expect(...querySelectorAll('option')).length).toBe(29)` → `30`.

The section follows the existing `AttendanceView.vue` conventions: inline `shouldShowAdminSection(ID)` + `adminSectionBinding(ID)`, `.attendance__admin-section` cards, inline `tr(en, zh)` localization (this view does not use the typed label modules), `apiFetch` / `apiGet`, the `data-admin-quick-jump` anchor wiring, and a stable section ID for the nav. Because the view is a large single-file component with known editing hazards (numeric `v-model` coercion; debug locally rather than via CI), the three cards are added together but kept small and are tested **locally** first.

## 9. Out of scope (deferred)

- **Employee self-service** — no `/me` self-view of balance or operations here; that is a separate future endpoint with the subject locked to the authenticated token.
- **Full audit-history viewer** — a browsable run/registry/ledger history UI (beyond the per-action summary + the L5a recent-events list) is a later slice.
- **L6 staging smoke** — the end-to-end smoke is its own gated step. It must exercise the **L1 year-end expiry/reaper** path in `packages/core-backend/src/services/AttendanceExpiryService.ts` (lots whose `expires_at <= now()` are reaped and an `annual_leave_expiry` event written) by advancing time / triggering the scheduler — **not** just the plugin routes — alongside the three operation endpoints.
- **Per-org admin scope, terminated-employee final settlement, reconcile-style adjustment chains** — out of L5c by design (see the engine design-lock).

## 10. Build sequencing (within ONE PR)

Order the work inside the single PR by blast radius, smallest first:

1. **Manual adjustment** — smallest blast radius (one user, ± one balance) and the **client-preview** card; establishes the confirm + summary scaffold and the failure-code map.
2. **Expiry backfill** — establishes the **server-dryRun** pattern (`dryRun:true` → auditable `{ scanned, updated, skipped, reasons }` table) on an idempotent-by-nature action.
3. **Accrual run** — highest stakes (grants the period for the whole active population); reuses the server-dryRun pattern, adds the period guardrail (§7) and the `alreadyGranted` idempotency surface.

Anchor-nav literals (§8) and the nav-group wiring land with the section; the policy.enabled gating (§6) is shared across all three cards.

Written to `/Users/chouhua/Downloads/Github/metasheet2/docs/development/attendance-annual-leave-admin-operations-design-lock-20260617.md`.