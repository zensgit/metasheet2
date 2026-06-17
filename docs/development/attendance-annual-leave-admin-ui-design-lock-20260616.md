# Annual-leave admin UI — design-lock (L5)

Status: locked 2026-06-16 (owner 拍板). Follows the completed backend engine L0–L4 (on `main`). L5 is the administrator UI for the annual-leave / statutory-annual-leave (年假 / 法定年假) balance engine. v1 is deliberately **read + config only**; balance-mutating triggers are out of v1.

## Scope

Two slices ship in v1, each its own PR:

- **L5a** — a balance / ledger **read** endpoint + a **read-only** view.
- **L5b** — an `annualLeavePolicy` **config** surface.

**L5c (deferred to its own design-lock):** UI triggers for the three balance-mutating admin actions — accrual run, manual adjustment, expiry backfill. These stay **API-only** for now. Putting them behind a button requires dry-run-first, explicit confirmation, an idempotency-result explanation, and a failure-reason surface; that is a separate, deliberately gated design, not part of L5a/L5b.

## L5a — balance / ledger read + read-only view

**Endpoint.** A new `GET` route, gated by `attendance:admin`, **admin-only** and **org-scoped**. An administrator queries by user (optionally by leave type). It returns enough to *explain* a balance, not just a number:

- **summary** — `remaining` / `granted` / `expired` / `exhausted` minutes.
- **active lots** — the contributing lots (`amount_minutes`, `remaining_minutes`, `source_type`, `source_id`, `expires_at`, `status`).
- **recent events** — the ledger (`grant` / `deduct` / `expire`), limited or paginated but **present**, so an administrator can see *why* the balance is what it is (accrual, manual adjustment, deduction, expiry).

An employee **self-service** balance view is explicitly **out of scope** here: it will be a separate future endpoint under a `/me` 口径 with the subject locked to the authenticated token, never mixed into this admin read.

**View.** A read-only Balance block rendering the summary, the active lots, and the recent ledger.

## L5b — annualLeavePolicy config

A Policy block (same admin section) editing the policy: `enabled`, `tenureMode`, `standardDayMinutes`, the tier ladder, `carryover.enabled`, `timezone`. It writes through the existing settings update path. Client-side guards mirror the backend contract (the server already rejects; the UI guards for usability):

- when `enabled`, `timezone` is required and must be a valid IANA identifier;
- the tier ladder must be contiguous / well-formed.

## Placement

A **new admin navigation section** ("年假 / 法定假", or "年假余额") — **not** folded into the existing Settings card. Inside it, two sub-blocks: **Balance** (L5a) and **Policy** (L5b).

## Conventions (grounded in the existing surface)

`AttendanceView.vue` renders admin sections inline (`shouldShowAdminSection(ID)` + `adminSectionBinding(ID)`), using `.attendance__admin-section` cards, inline `tr(en, zh)` localization (this view does not use the typed label modules), the `apiFetch` / `apiGet` client (which carries the auth + tenant headers), and `withPermission('attendance:admin')` on the backend with an `adminForbidden` gate in the UI. L5 follows these. The view is a large single-file component with known editing hazards (numeric `v-model` coercion; debug locally rather than via CI), so L5 frontend slices stay small and are tested locally first.

## Sequencing

L5 design-lock (this) → **L5a** (read endpoint + read-only UI) → **L5b** (policy config UI). **L5c** is a separate later design-lock; the three action endpoints remain API-only in the meantime.

## Out of scope (deferred)

- L5c — admin trigger buttons (accrual run / manual adjustment / expiry backfill).
- Employee self-service balance view (`/me`).
- L6 — staging smoke.
- Deployment readiness — the engine's target population is active organization membership; confirm on staging that the relevant employees are present in that membership, else the engine (and this view) shows nothing to operate on.
