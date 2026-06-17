# Annual-leave balance engine — design & verification (L0–L4)

Status: backend engine complete on `main` (2026-06-16). This document is the capstone record for the annual-leave / statutory-annual-leave (年假 / 法定年假) balance engine: the design in MetaSheet's own terms, and an honest verification trail including what review caught and how it was fixed. Frontend (L5) and a staging smoke (L6) remain and are scoped at the end.

## 1. What the engine does

Annual-leave entitlement is managed as a **lot-based balance ledger**. Entitlement is **accrued** for a period year, may be **manually adjusted** by an administrator, is **deducted** when a leave request is approved, and **expires** at a year-end boundary. The whole engine is **off by default** and activates only when an organization enables `annualLeavePolicy`; with it off, behavior is exactly as before (no balance is touched).

## 2. Ledger model

Two tables, shared generically across leave types (annual reuses the same ledger as comp-time):

- `attendance_leave_balances` — one row per **lot**: `amount_minutes`, `remaining_minutes`, `source_type`, `source_id` (provenance back-link), `source_key` (idempotency, unique per org), `expires_at`, `status`. The generic ledger admits `active` / `exhausted` / `expired` / `revoked`; the annual L0–L4 chain uses only the first three (`revoked` is a ledger capability this chain does not exercise).
- `attendance_leave_balance_events` — append-only audit, each with a signed `delta_minutes` (a sign check forbids zero) and the same `source_type` / `source_id`. The generic ledger admits `grant` (positive) / `deduct` / `expire` / `revoke` (negative); the annual L0–L4 chain emits only `grant` / `deduct` / `expire`.

A balance is the sum of `remaining_minutes` over a user's `active`, non-expired annual lots. Deductions consume lots **oldest-expiring first**.

## 3. Slice design (L0 → L4)

**L0 — latent config + generic deductor.** `annualLeavePolicy` settings (enabled, tenure mode, standard-day minutes, tier ladder, carryover, timezone) and a leave-type-generic `deductLeaveBalance` engine. Comp-time becomes a thin wrapper over it, byte-identical in behavior.

**L1 — expiry source-type generalization.** The expiry scheduler derives a per-leave-type expiry event source-type, so annual lots reap as `annual_leave_expiry` (comp-time unchanged).

**L2a — accrual schema.** `attendance_leave_accrual_runs` + `attendance_leave_accrual_run_items` (per-user provenance: tenure, tier, proration factor, entitlement, status, skip reason), and `users.cumulative_service_start_date` as the cumulative-tenure anchor distinct from `hire_date`.

**L2b — accrual snapshot engine.** Eligibility (continuous 12 months of service) → tier from cumulative service years (statutory ladder 5/10/15 days) → first-year proration (本单位 remaining-calendar-days ÷ 365 × tier, computed **integer-first** to avoid a float-floor underpaying a whole statutory day) → idempotent lot grant with a run/run-item provenance trail. The model is **period + asOf**: `period` is which year's entitlement; `asOf` is the evaluation date (eligibility and tier judged as of `asOf`). A dry run previews (run + items persisted, no lots). Enumeration is scoped to the organization's active members.

**L2c — manual adjustment.** An administrator's signed ± to a user's annual balance, applied via **lot mutation** (positive → a new lot + grant event; negative → FIFO deduct + deduct event), recorded in a who/why audit registry. Idempotent on a request key; an insufficient negative rolls the whole transaction back (no registry row). The target user must be an active member of the claimed org; `run_id` may link a correction to the accrual run it fixes but never overwrites that run's snapshot.

**L3 — approval deduction.** On final approval of an `annual`-coded leave request, the annual balance is deducted on a **standard-day basis**: `(request minutes × standard-day minutes) / leave-type default-minutes-per-day`, computed integer-first with an exact-divisibility check. Gated on `annualLeavePolicy.enabled` (off → approve, never touch balance). Insufficient or non-whole → 422, request stays pending. v1 is **single-day** (a request whose minutes exceed one standard work day is rejected). Idempotency is inherited from the approval transition guard.

**L4a — grant-time year-end expiry.** Each accrual lot is granted with an `expires_at` equal to the **first-invalid instant** — `Jan 1 00:00:00` of `period + (carryover ? 2 : 1)` in the org timezone, as a UTC instant. Carryover off → usable through the end of the period year; carryover on → carries through the following year. The existing expiry scheduler reaps it; no new reaper. Computed once from the run's policy snapshot, so a later carryover change is never retroactive.

**L4b — provenance-snapshot backfill.** An application-layer, idempotent backfill (not a migration) that sets `expires_at` on pre-L4a annual lots whose expiry is null, deriving carryover / timezone / period from each lot's accrual-run provenance — never today's settings. It validates that the provenance genuinely belongs to the lot (this org's granted annual run-item; this org's real, non-dry-run annual run) and **never guesses**: an unrecoverable or mismatched lot is skipped under a reason code and left null. Returns an auditable `{ scanned, updated, skipped, reasons }`; `updated` counts only rows actually written.

## 4. Locked boundaries (口径)

- **Statutory basis.** Eligibility = continuous 12 months of service; tier from cumulative working time (5/10/15 days); first-year proration per the implementing rules. Sourced from the national regulations on gov.cn.
- **Expiry boundary** = the first-invalid instant (`Jan 1 00:00` org-tz), not `Dec 31 23:59:59`, to match the scheduler's `expires_at <= now()` reaping.
- **Timezone** must be a valid IANA identifier when the policy is enabled — rejected at the settings gate and the accrual run, so an invalid zone never silently falls back to UTC and stamps a wrong expiry.
- **Enabled-gate / default-off** = zero regression for an org that has an `annual` leave type but has not turned the engine on.
- **Standard-day deduction** keeps the entitlement basis distinct from a request's actual scheduled minutes.
- **Single-day v1**; multi-day annual leave is a deliberate future slice.
- **Never-guess backfill**; manual-adjustment lots are intentionally never auto-expired.

## 5. Verification trail

Each slice shipped with real-DB verification appropriate to its layer — schema/invariant checks (L2a), a service integration test (L1, the expiry scheduler), and booted-endpoint API tests (L2b, L2c, L3, L4a, L4b) — plus an adversarial sub-agent review and the CI matrix (`test (18.x)` + `test (20.x)` attendance integration). Only the endpoint-backed slices exercise the real API path. The honest part of the record is what **review caught** beyond the happy path:

- **L2b** — accrual correctness and scoping: the run enumerated users globally (cross-tenant bleed) → scoped to active organization membership; a cumulative-tenure user missing `hire_date` could be silently full-granted → explicit skip; calendar-invalid dates were accepted → round-trip rejection. (Earlier in the slice, an integer-first proration fix prevented a float-floor from underpaying a whole statutory day.)
- **L2c** — manual-adjustment scoping and contract: the actor/tenant guard, idempotency-conflict handling (409 when a reused key carries a different payload), `runId` validation plus a defensive FK, and the target-must-be-an-active-org-member guard. During #2687 review a staging-grounded check found the actor-must-be-`user_orgs`-member guard would 403 real admins (who are not org members) → reverted to the route-level global admin gate while keeping the target-membership guard, with the test corrected to walk the real RBAC path; this fix is part of the #2687 squash, not a post-merge change.
- **L3** — single-day scope was documented but not enforced → a multi-day-on-one-date request would over-deduct → rejected with 422.
- **L4a** — timezone validated for presence but not validity → an invalid zone silently UTC-fell-back → IANA validity enforced at the PUT and the accrual run.
- **L4b** — the provenance join was id-only → wrong-tenant / dry-run / skipped / non-annual provenance was treated as recoverable → validated with distinct reason codes; `updated` was unconditional → counted via `RETURNING` for concurrency-safe auditing; the target org was implicit → declared in the endpoint contract.
- A **Node-20 test flake** (asserting an event by array position over a random-UUID ordering) was made deterministic by asserting on event type.

Two verification layers proved complementary: adversarial sub-agent panels reliably caught math/legal and control-flow defects, while owner review caught codebase-fit issues (real tenancy data, RBAC reality, unenforced scope) that happy-path adversarial prompts missed — recorded as a standing lesson to attack failure **classes** (invalid-input validity, wrong-tenant/dry-run provenance, unenforced scope), not just correct-input round-trips.

### Merged PRs

L0 #2627 · L1 #2633 · L2a #2638 · L2b #2678 · L2c #2687 · L3 #2713 · L4a #2717 · L4b #2718.

## 6. Out of scope here (remaining)

- **L5** — administrator UI (annual-policy configuration surface + a balance view). Needs a design sign-off before build.
- **L6** — staging smoke against real data.
- **Deployment readiness** — the engine's target population is active organization membership; confirm on staging that the employees whose balances would be accrued/adjusted are present in that membership, or the engine is a no-op until it is populated.
