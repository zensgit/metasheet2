# Attendance shift-swap SW5 staging smoke runbook

**Date:** 2026-06-12
**Script:** `scripts/ops/staging-attendance-shift-swap-sw5-smoke.mjs`
**Scope:** SW5 closeout prep only. The script and this runbook do **not** flip
the tracker to ✅; the tracker flips only after a real staging PASS stamp.

## What This Proves

The smoke runs the same shift-swap HTTP chain used by the employee/admin UI:

- admin configures safe scheduling settings and creates two shifts plus two
  published manual source assignments;
- requester creates a swap through `POST /api/attendance/shift-swap-requests`;
- counterparty accepts through the dedicated consent route;
- admin final-approves through the normal attendance request approval route;
- final approval soft-deactivates exactly the two source assignments;
- final approval creates exactly two published replacement assignments with
  deterministic `producer_type='shift_swap'`, `producer_ref_id`, `producer_key`,
  and `producer_run_id`;
- effective-calendar follows the swapped schedule for both users. In single-slot
  mode the public response may expose only `effective.source='shift'`; the exact
  source/replacement shift ids are proven by the DB assignment assertions, and
  the smoke also validates `shiftId` when the API exposes `effective.slots[]`;
- `attendance_events` and `attendance_records` stay unchanged;
- cleanup restores settings and removes the smoke rows with residue `0`.

This is the final SW5 staging gate for the `换班` line. It does not exercise
browser visuals; SW4 already locks the frontend request bodies and lazy-loading
contracts in web tests.

## Prerequisites

1. Staging runs a main build that includes:
   - SW1 schema/envelope `#2539`;
   - SW2 create/consent API `#2540`;
   - SW3 final approval writer `#2541`;
   - SW4 admin/employee UI `#2542`.
2. Staging migrations are current through
   `zzzz20260612120000_create_attendance_shift_swap_requests`.
3. Run from the repo root on the staging host, or from a tunnel where both API
   and DB are reachable.
4. `pg` must be resolvable from Node.
5. `DEPLOY_SHA` is required and must name the staging build being smoked. The
   script refuses to print a PASS stamp without it.
6. Authentication:
   - default path: staging allows `/api/auth/dev-token`, and the script mints
     admin, requester, and counterparty tokens;
   - fallback path: provide `ADMIN_TOKEN`, `REQUESTER_TOKEN`,
     `COUNTERPARTY_TOKEN`, `REQUESTER_USER_ID`, and `COUNTERPARTY_USER_ID`.
     The requester/counterparty token subjects must equal those user ids.

The requester and counterparty users default to fresh synthetic
`shiftswap-sw5-*` subjects. The script refuses non-synthetic
requester/counterparty users, and it also refuses reused synthetic users that
already have attendance requests, assignments, events, or records. This is
intentional: a staging smoke should never be pointed at real employee history.

Before any API mutation, the script runs a read-only DB preflight that verifies
the cleanup/assertion channel is reachable and the shift-swap tables exist. It
then creates and immediately deletes a stamped probe shift through the API while
checking that the same row is visible through `DATABASE_URL`. If the API and DB
do not point at the same staging instance, the smoke aborts before the shift-swap
business flow starts.

## Run

```bash
BASE_URL=http://127.0.0.1:8082 \
DATABASE_URL=postgresql://USER@127.0.0.1:5432/metasheet \
DEPLOY_SHA=<staging-main-sha> \
node scripts/ops/staging-attendance-shift-swap-sw5-smoke.mjs
```

Fallback when dev-token is disabled:

```bash
BASE_URL=http://127.0.0.1:8082 \
DATABASE_URL=postgresql://USER@127.0.0.1:5432/metasheet \
DEPLOY_SHA=<staging-main-sha> \
ADMIN_TOKEN='<admin bearer>' \
REQUESTER_TOKEN='<requester synthetic-user bearer>' \
REQUESTER_USER_ID='<requester-token-subject>' \
COUNTERPARTY_TOKEN='<counterparty synthetic-user bearer>' \
COUNTERPARTY_USER_ID='<counterparty-token-subject>' \
node scripts/ops/staging-attendance-shift-swap-sw5-smoke.mjs
```

Optional:

```bash
ORG_ID=default
REQUESTER_WORK_DATE=2026-07-03
COUNTERPARTY_WORK_DATE=2026-07-04
```

The requester/counterparty subjects must remain disposable
`shiftswap-sw5-*` users for fallback tokens.

## Expected Output

```text
SW5 shift-swap staging smoke @ http://127.0.0.1:8082 (org default, stamp shift-swap-sw5-...)
  PASS  DB cleanup/assertion channel reachable and shift-swap tables exist
  PASS  auth: GET settings 200
  PASS  synthetic requester/counterparty have no pre-existing attendance residue
  PASS  API/DB coherence probe created shift via API
  PASS  API/DB coherence probe is visible through DATABASE_URL
  PASS  API/DB coherence probe deleted via API
  PASS  save settings shiftEditPolicy,shiftCompliance,multiShiftDay
  PASS  create shift requester-source
  PASS  create shift counterparty-source
  PASS  create published source assignment requester
  PASS  create published source assignment counterparty
  PASS  pre-swap requester effective-calendar sees a shift source
  PASS  pre-swap counterparty effective-calendar sees a shift source
  PASS  create shift_swap approval flow
  PASS  create shift-swap request
  PASS  requester list sees the pending shift-swap request
  PASS  counterparty accepts
  PASS  admin final approval succeeds
  PASS  detail row finalized with both replacement ids
  PASS  source assignments are soft-deactivated after approval
  PASS  exactly two replacement assignments exist
  PASS  requester replacement has counterparty shift/date and deterministic provenance
  PASS  counterparty replacement has requester shift/date and deterministic provenance
  PASS  post-swap requester effective-calendar sees a shift source on counterparty date
  PASS  post-swap counterparty effective-calendar sees a shift source on requester date
  PASS  attendance_events and attendance_records are unchanged by the swap finalizer
--- restore + cleanup ---
  PASS  restore original settings
  PASS  cleanup residue = 0 (... approval_instances 0, approval_records 0, approval_assignments 0, events 0, records 0)

=== PASS — ... passed, 0 failed ===  stamp shift-swap-sw5-...
SHIFT_SWAP_SW5_STAGING_SMOKE_PASS deploy=<sha> stamp=shift-swap-sw5-... requesterDate=... counterpartyDate=... residue=0
```

## On PASS

Flip the tracker row `调度 / 换班 / 小组织` to reflect `换班` ✅ while
keeping `调度` separate, and add a dated backfill like:

> **回填（YYYY-MM-DD 换班 SW5 staging closeout）**：staging smoke
> `SHIFT_SWAP_SW5_STAGING_SMOKE_PASS` on deploy `<sha>`（stamp
> `<stamp>`，requesterDate `<date>`，counterpartyDate `<date>`）：admin created
> two published manual source assignments; requester created the dedicated
> shift-swap request; counterparty accepted; final approval soft-deactivated
> exactly the two source rows and created exactly two published
> `producer_type='shift_swap'` replacement rows with deterministic provenance;
> effective-calendar showed the swapped shift-source days for both users while
> DB assertions proved the exact replacement shift ids; events/records stayed
> unchanged; settings restored; cleanup residue=0. SW1 #2539 → SW2 #2540
> → SW3 #2541 → SW4 #2542 → SW5 staging closed `换班` ✅. `调度` still separate
> OPTIONAL.

## On FAIL

- `DB cleanup/assertion channel` fails: staging is missing the SW1 migration or
  `DATABASE_URL` points at the wrong database. Do not continue until the DB
  channel is reachable.
- `API/DB coherence probe` fails: `BASE_URL` and `DATABASE_URL` are not pointed
  at the same staging instance, or the API-created probe shift could not be
  deleted. Inspect the stamped probe shift before re-running.
- token/auth failure: verify `BASE_URL`, token, staging JWT secret, and that
  fallback requester/counterparty token subjects equal the provided user ids.
- source assignment create fails: staging may have stale scheduling settings;
  the script tries to set `shiftEditPolicy` unrestricted and `shiftCompliance`
  warning/null first, then restores the original settings at cleanup.
- `SHIFT_SWAP_APPROVAL_FLOW_REQUIRED`: the active `shift_swap` approval flow did
  not persist or the deployed backend predates SW1/SW2.
- final approval fails before replacement rows: inspect the response error. A
  conflict, edit-window, or compliance error means the guarded transaction is
  blocking the staging data; do not flip ✅.
- effective-calendar fails to show replacement shifts: SW3 finalization may have
  written rows that the resolver cannot see, or staging is not running the
  deployed SHA.
- events/records changed: the swap finalizer polluted historical attendance
  facts; do not flip ✅.
- residue nonzero: inspect rows with the printed `shift-swap-sw5-*` stamp and
  the two synthetic user ids before re-running.

## Safety

- Creates only stamped shifts/approval flows and synthetic
  `shiftswap-sw5-*` requester/counterparty users.
- Direct SQL cleanup targets the created request ids, created approval instance
  ids/business keys plus their approval records/assignments, created assignment
  ids, created shift ids, created flow ids, and deterministic `shift_swap`
  provenance from the created request ids.
- The smoke never deletes `attendance_events` or `attendance_records`; those
  tables must remain at zero for the fresh synthetic users, proving shift-swap
  did not touch historical attendance facts.
- Cleanup is gated: if the synthetic-user/token safety checks do not pass, the
  script skips destructive cleanup because no API mutation should have happened.
- Restores original attendance settings before deleting smoke rows.
- Does not deploy, restart services, or mutate scheduler/background settings.
