# Attendance OT-bank v1-8 staging smoke runbook (三例验收 + settlement snapshot)

**Date:** 2026-07-02

**Status:** PREPARED. This runbook does **not** claim a staging PASS. It is the
operator checklist for closing overtime-bank v1-8 after the v1-1..v1-6 chain
(plus the #3255 must-pay e2e and the #3303 settings-restore hygiene fix) is
deployed to staging.

Do not mark the overtime-bank v1 arc complete from this document alone. The
closeout happens only after a real run records the PASS stamp in the section
below **and** the operator-decision blocks in this document are resolved.

**Scope:** v1-8 closes the overtime-bank v1 arc end to end on staging:

- 账1 accrual: overtime approval grants per-source comp-time lots when the bank
  is enabled, and keeps the legacy NULL-source single lot when dormant;
- 账2 offset: a rule-driven leave approval deducts the comp-time pool FIFO,
  with `partial_unpaid_absence` shortfall behavior;
- 账3 result: the full-attendance flag breaks on any raw leave, even when the
  pool offset it;
- 账4 settlement: cycle close writes the immutable settlement snapshot rows
  (convertible from close-time balance, must-pay from period facts, statutory
  overtime never poolable/convertible), replay-idempotent, period-frozen;
- cleanup residue `0`.

It does not add runtime code, a payout producer (v1-7), a settlement read API
(v1-5d), cross-pool deduction order (v2), or any payroll amount computation.

## What This Proves

The smoke must prove the deployed staging build runs the full
accrual → offset → settlement money path with the ratified invariants:

1. With `overtimeBankPolicy` dormant, an approved overtime request grants the
   legacy single NULL-source `comp_time` lot keyed
   `overtime_conversion:<requestId>` (byte-identical legacy path).
2. `PUT /api/attendance/settings` rejects
   `overtimeBankPolicy.pooledSources=['statutory_holiday']` with `400`
   (compliance floor: statutory-holiday overtime is never poolable).
3. With the bank enabled (`pooledSources=['workday']`), an approved workday
   overtime request grants exactly one per-source lot keyed
   `overtime_conversion:<requestId>:workday` with `overtime_source='workday'`.
4. Replaying the approval is rejected (`400 INVALID_STATUS`) and never
   double-credits a lot or a grant ledger event.
5. The three owner acceptance cases hold (compressed, minutes-based — see the
   operator-decision block OQ-1): with +600 pool per user, leave of
   600 / 300 / 900 minutes deducts 600 / 300 / 600, leaves remaining
   0 / 300 / 0, and produces a real-absence shortfall of 0 / 0 / 300
   (`insufficient='partial_unpaid_absence'`), with ledger conservation
   `granted = remaining + exhausted + expired` on the read API.
6. The full-attendance flag is `false` for all three case users (any leave
   breaks it, even pool-offset leave) and `true` for the overtime-only control
   user.
7. Statutory-holiday overtime with the bank enabled banks NOTHING (fail-closed
   must-pay), and at cycle close the statutory settlement row carries
   `must_pay_minutes` from the PERIOD facts (480), `convertible_minutes=0` —
   an injected poison 9999-minute statutory balance lot never surfaces.
8. Cycle close (open→closed) writes the settlement snapshot in the same
   transaction: case2 gets one `workday` row `convertible=300 / must_pay=0`
   with frozen `period_start_date` / `period_end_date` / `closed_at` and the
   snapshotted policy; case1/case3 get no row (zero-zero skipped); the dormant
   user's NULL-source balance settles as `legacy_unsourced` convertible.
9. Replay close returns `200` and changes nothing (`ON CONFLICT DO NOTHING`);
   a period change on the closed cycle returns
   `409 CYCLE_CLOSED_PERIOD_FROZEN`; DELETE returns
   `409 CYCLE_CLOSED_NOT_DELETABLE`.
10. Cleanup removes synthetic users, memberships, requests, records, events,
    lots (ledger events cascade), fixtures (leave type / overtime rule /
    holiday), approval-engine rows, settlement rows, and the payroll cycle,
    restores settings, and the residue check is `0` in every category.

## Operator-Decision Blocks (resolve before the final stamp)

### OQ-1 — 三例验收 mapping (owner call)

The owner acceptance table is framed as a 176h monthly schedule with hours
(+10h overtime; 10h / 5h / 15h leave; effective hours 176/176/171). This smoke
replays the **pool arithmetic** of those three cases in minutes
(600 / 300 / 900 vs a 600-minute pool) and asserts pool remaining, deduction,
shortfall (real absence), full-attendance flag, and cycle-end convertible —
it does **not** rebuild a full month of 176 scheduled hours, and it does not
assert the schedule-level effective-hours aggregate (amounts and payroll
aggregation stay out of scope by design). **OPEN QUESTION:** confirm the
compressed replay satisfies 三例验收, or require a full-month schedule replay
before stamping. Record the decision next to the PASS stamp.

### OQ-2 — shared org vs dedicated smoke org (population scope)

The settlement population at cycle close is org-wide: users with period facts
UNION users with **any active comp-time balance** (period-independent). On a
shared org (`ORG_ID=default`), closing the smoke cycle would enumerate real
balance-holders into the smoke cycle's settlement rows (all rows are deleted
by `cycle_id` in cleanup, but real user ids would transit through a synthetic
snapshot). The helper fails closed when it detects non-synthetic population
and only proceeds with `ALLOW_NON_SYNTHETIC_SETTLEMENT_POPULATION=1`
(dangerous). **OPEN QUESTION:** either accept the override explicitly on a
quiet window, or run with a dedicated smoke `ORG_ID` — note that issuing
tokens and route behavior for a non-default org id has not been verified in
this repo; verify on the staging host before choosing that path.

### OQ-3 — token minting path

The staging environment sets a production node-env, under which
`GET /api/auth/dev-token` returns `404`. Two candidate mint paths exist in the
repo (`scripts/gen-staging-token.js` signing with the host's staging JWT
secret; `scripts/ops/resolve-attendance-smoke-token.sh` minting inside the
backend container) but neither is named as the approved smoke-token path by
the AE-4 family docs. **OPEN QUESTION:** the operator picks the mint path and
provides `ADMIN_TOKEN` plus the five per-user tokens (`CASE1_TOKEN`,
`CASE2_TOKEN`, `CASE3_TOKEN`, `MUSTPAY_TOKEN`, `DORMANT_TOKEN`) whose subjects
equal the synthetic user ids — business requests are created AS the token
subject, so a mismatched subject would attribute rows to a user the cleanup
does not cover. The helper refuses mismatched subjects.

Note: on non-staging rehearsal runs where `GET /api/auth/dev-token` IS
available, each dev-token mint inserts a `user_sessions` row for the stamped
synthetic users; those session rows are expected out-of-ledger (not counted in
the residue gate, harmless — no FK to `users`) and do not occur on staging,
where the dev-token route returns `404`.

### OQ-4 — settlement assertions are SQL-only

`attendance_payroll_cycle_settlements` has no API read surface (the v1-5d read
exit is designed but not built), and the leave-balances read API omits
`overtime_source` / `source_key` from its lot projection. Per-source lot
tagging and every settlement-row assertion in this smoke therefore go through
`DATABASE_URL` directly, following the AE-4 family split (HTTP for business
writes, SQL for exact assertions). **OPEN QUESTION:** confirm SQL-assert is an
acceptable channel for the v1-8 stamp, or gate v1-8 behind landing v1-5d
first.

### OQ-5 — expiry reaper interference

Grants stamped with an expiry are reaped by the attendance expiry service.
This smoke sets `compTimeFromOvertime.expiresInDays=null` (no expiry) so no
scheduler can mutate smoke lots mid-run; whether staging currently runs the
expiry scheduler was not verified from the repo. Keep `expiresInDays` null.

### OQ-6 — real segmentation engine instead of snapshot injection

The CI must-pay e2e injects the overtime-segmentation snapshot into request
metadata via SQL after approval. This smoke instead drives the REAL engine:
`overtimeSegmentation.enabled=true`, same-day overtime on a weekday (workday
bucket) and on a seeded holiday row (holiday bucket → statutory must-pay).
This is closer to production truth; the arithmetic (rule `minMinutes=0`,
`roundingMinutes=1`) is chosen so the rule-normalized total equals the raw
minutes and the owner-case numbers stay exact.

## Prerequisites

1. Deploy a main build that includes:
   - v1-1a/b `overtimeBankPolicy` config + per-source grant lots;
   - v1-2a/b `leaveBalanceDeductionPolicy` config + rule-driven FIFO offset;
   - v1-3a/b `attendanceBonusPolicy` + full-attendance flag on the summary;
   - v1-5a/b settlement table, compute, close hooks, freeze guards;
   - v1-6 policy admin UI (for the optional UI probe);
   - the #3255 must-pay e2e and the #3303 unconditional-settings-restore fix.
2. Staging migrations are current through:
   - `attendance_leave_balances` (+ `overtime_source` column) and
     `attendance_leave_balance_events`;
   - `attendance_payroll_cycles` and `attendance_payroll_cycle_settlements`
     (settlement FK is `ON DELETE RESTRICT`);
   - the shared approval-engine tables (`approval_instances`,
     `approval_assignments`, `approval_records`).
3. `BASE_URL` points at the staging API.
4. `DATABASE_URL` points at the same staging database. The operator must run a
   quick API/DB coherence probe before mutating business rows.
5. Authentication per OQ-3: admin token with `attendance:read`,
   `attendance:write`, `attendance:admin`, `attendance:approve`; five per-user
   tokens with `attendance:read`, `attendance:write` whose subjects equal the
   synthetic user ids.
6. Use only synthetic ids with an `otbank-v18-smoke-*` prefix. Do not point
   cleanup at real employees. Business text fields (reasons, rule/leave-type/
   holiday/cycle names) must carry the stamp; the SQL-seeded poison lot key
   must begin `otbank-v18-smoke:<STAMP>:`.
7. Run inside the bundled staging window
   (`docs/development/attendance-staging-window-bundle-20260702.md`), after the
   previous smoke restored its settings.

## Suggested Environment

```bash
BASE_URL=http://127.0.0.1:8082            # staging root via your tunnel
DATABASE_URL=postgresql://<redacted>@127.0.0.1:5432/metasheet
DEPLOY_SHA=<deployed-main-sha>
ORG_ID=default                            # see OQ-2 before accepting this
STAMP=otbank-v18-smoke-$(date +%s)
ADMIN_TOKEN='<admin bearer token>'
CASE1_TOKEN='<bearer, subject = <STAMP>-case1>'
CASE2_TOKEN='<bearer, subject = <STAMP>-case2>'
CASE3_TOKEN='<bearer, subject = <STAMP>-case3>'
MUSTPAY_TOKEN='<bearer, subject = <STAMP>-mustpay>'
DORMANT_TOKEN='<bearer, subject = <STAMP>-dormant>'
```

The PASS stamp must include `DEPLOY_SHA`, `STAMP`, and residue `0`. Do not use
a local branch SHA as the deploy SHA.

## API/DB Helper

Use the helper to execute the backend portions of this runbook:

```bash
BASE_URL="$BASE_URL" \
DATABASE_URL="$DATABASE_URL" \
DEPLOY_SHA="$DEPLOY_SHA" \
ORG_ID="${ORG_ID:-default}" \
STAMP="$STAMP" \
ADMIN_TOKEN="$ADMIN_TOKEN" \
CASE1_TOKEN="$CASE1_TOKEN" CASE2_TOKEN="$CASE2_TOKEN" CASE3_TOKEN="$CASE3_TOKEN" \
MUSTPAY_TOKEN="$MUSTPAY_TOKEN" DORMANT_TOKEN="$DORMANT_TOKEN" \
node scripts/ops/staging-attendance-overtime-bank-v18-smoke.mjs
```

The helper drives the real staging API for settings, fixtures, requests,
approvals, and the cycle create/close; it uses SQL only for synthetic user
seed, the poison lot, exact lot/ledger/settlement assertions, and cleanup. A
successful run prints:

```text
OTBANK_V18_API_DB_SMOKE_PASS deploy=<sha> stamp=<otbank-v18-smoke-...> org=<org> cycle=<uuid> residue=0
```

This is **not** the final v1-8 PASS stamp. The final closeout requires the
operator to (a) verify the deployed build (`/api/health` `build.commit` equals
`DEPLOY_SHA`), (b) resolve the operator-decision blocks above (OQ-1 and OQ-2
at minimum), and (c) optionally run the UI probe below — only then record
`OTBANK_V18_STAGING_SMOKE_PASS`.

## Preflight

Run these checks before creating any business rows:

1. API health returns success for the deployed build and `build.commit`
   equals `DEPLOY_SHA`.
2. Admin token can call `GET /api/attendance/settings` (a `401` means a
   wrong-realm token — re-mint; a `503 DB_NOT_READY` means staging is not
   migrated — STOP and run the migration-alignment SOP first).
3. DB has the required tables:

```sql
SELECT to_regclass('attendance_leave_balances') IS NOT NULL AS lots_ok,
       to_regclass('attendance_leave_balance_events') IS NOT NULL AS ledger_ok,
       to_regclass('attendance_payroll_cycles') IS NOT NULL AS cycles_ok,
       to_regclass('attendance_payroll_cycle_settlements') IS NOT NULL AS settlements_ok,
       to_regclass('approval_instances') IS NOT NULL AS approvals_ok;
```

4. API/DB coherence probe: after the first settings PUT, confirm the
   `overtimeBankPolicy` key is visible through `DATABASE_URL` in
   `system_configs` under key `attendance.settings`. Abort if API and DB are
   not the same staging instance.
5. Save current attendance settings so the smoke can restore them:

```bash
curl -sS -H "Authorization: Bearer $ADMIN_TOKEN" \
  "$BASE_URL/api/attendance/settings" > /tmp/otbank-v18-settings-before.json
```

6. Verify zero pre-existing residue for this `STAMP` (fresh stamp per run).

## Window and Seed

The smoke uses a far-future, conflict-free settlement window (one full month,
default: October of a helper-chosen year ≥2041; `SMOKE_YEAR` overridable, but
only values in **2030–2099** are honored — an out-of-range override silently
falls back to the hash-seeded default year, so re-check the helper's printed
window if you override) so that:

- no real records/requests exist inside the period (the period arm of the
  settlement population stays synthetic by construction);
- no synced holiday rows shift the day-type of the smoke dates;
- no existing payroll cycle overlaps the period (an exact-period duplicate
  returns `409 ALREADY_EXISTS` on create).

Within the window: overtime accrual on the first Monday (workday), leave
offset on the Tuesday, seeded statutory holiday + holiday overtime on the
Wednesday.

Seed five disposable users and active org memberships (SQL, upsert):

- `otbank-v18-smoke-<stamp>-case1|case2|case3` (owner cases)
- `otbank-v18-smoke-<stamp>-mustpay` (statutory boundary)
- `otbank-v18-smoke-<stamp>-dormant` (dormant-bank regression + no-leave
  full-attendance control)

Fixtures (via API, all stamped): one overtime rule
(`minMinutes=0, roundingMinutes=1`), one offset leave type (code
`<STAMP>-offset`), one holiday row (`isWorkingDay=false`) on the Wednesday.

The smoke may use direct SQL for seed/assert/cleanup, but every accrual,
offset, approval, and cycle transition must go through the deployed API.

## Step 1 — dormant-bank grant regression

Set the policy baseline (segmentation + grant on, bank OFF):

```bash
curl -sS -X PUT "$BASE_URL/api/attendance/settings" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  --data '{
    "overtimeSegmentation": { "enabled": true },
    "compTimeFromOvertime": { "enabled": true, "expiresInDays": null },
    "overtimeBankPolicy": { "enabled": false, "pooledSources": [] }
  }'
```

As the dormant user: `POST /api/attendance/requests`
`{workDate:<Monday>, requestType:'overtime', overtimeRuleId, minutes:120, reason:'OTBANK v1-8 smoke <STAMP> dormant regression'}`,
then approve as admin via `POST /api/attendance/requests/:id/approve`.

Backend assertions:

```sql
SELECT source_key, overtime_source, amount_minutes, remaining_minutes, expires_at
FROM attendance_leave_balances
WHERE org_id = :org_id AND source_type = 'overtime_conversion' AND source_id = :dormant_request_id;
```

Expected:

- exactly one lot; `source_key = 'overtime_conversion:<requestId>'` (no
  per-source suffix); `overtime_source` is NULL; amount = remaining = 120;
  `expires_at` is NULL;
- exactly one `grant` ledger event of +120 for that request.

## Step 2 — enable the bank + offset rule + full-attendance flag

First probe the compliance floor: `PUT /api/attendance/settings` with
`{"overtimeBankPolicy":{"enabled":true,"pooledSources":["statutory_holiday"]}}`
must return `400` (the pooled-sources enum excludes statutory holidays).

Then enable the real matrix:

```bash
curl -sS -X PUT "$BASE_URL/api/attendance/settings" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  --data '{
    "overtimeBankPolicy": { "enabled": true, "pooledSources": ["workday"] },
    "leaveBalanceDeductionPolicy": {
      "enabled": true,
      "rules": [{ "requestLeaveType": "<STAMP>-offset", "deductFrom": ["comp_time"], "insufficient": "partial_unpaid_absence" }]
    },
    "attendanceBonusPolicy": { "enabled": true, "anyLeaveBreaksFullAttendance": true, "lateBeyondThresholdBreaksFullAttendance": true }
  }'
```

Note: `PUT /api/attendance/settings` merges per policy key — this PUT does not
disturb sibling policies, and the restore in Step 8 must therefore explicitly
re-assert every key this smoke touched (never PUT an empty snapshot).

## Step 3 — the three owner cases (accrual + offset)

For each case user (`case1`, `case2`, `case3`):

1. As the case user: create workday overtime on the Monday
   (`minutes=600`, stamped reason), approve as admin.
2. Assert (SQL) exactly one lot `overtime_conversion:<requestId>:workday`,
   `overtime_source='workday'`, amount 600.
3. Replay the approve: expect `400 INVALID_STATUS`, and no second lot or
   grant event.
4. Assert (API) `GET /api/attendance/leave-balances?userId=<user>&leaveTypeCode=comp_time`
   shows granted=600, remaining=600.
5. As the case user: create the offset leave on the Tuesday with
   `leaveTypeCode=<STAMP>-offset` and minutes 600 / 300 / 900 respectively,
   stamped reason; approve as admin (case3 approves too —
   `partial_unpaid_absence` mode).
6. Assert (SQL) the `leave_offset` deduct events for that leave request sum to
   600 / 300 / 600.
7. Assert (API) the balance read shows remaining 0 / 300 / 0, exhausted
   600 / 300 / 600, expired 0, and conservation
   `granted = remaining + exhausted + expired`.
8. Compute shortfall = requested − deducted = 0 / 0 / 300 (case3's 300 = the
   real absence of the owner table).

The `insufficient='block'` variant (422 + rollback) is covered by the CI
real-DB matrix and is not re-proven here.

## Step 4 — statutory must-pay boundary + poison lot

1. As admin: `POST /api/attendance/holidays`
   `{date:<Wednesday>, name:'<STAMP> statutory holiday', isWorkingDay:false}` → `201`.
2. As the mustpay user: create overtime on the Wednesday (`minutes=480`),
   approve as admin.
3. Assert (SQL) ZERO lots exist for that request — holiday overtime is mapped
   to the statutory source, which is never poolable; with the bank enabled the
   grant fails closed to must-pay.
4. Seed the poison lot (SQL, stamped key):

```sql
INSERT INTO attendance_leave_balances
  (org_id, user_id, leave_type_code, amount_minutes, remaining_minutes,
   source_type, source_key, status, granted_at, overtime_source)
VALUES
  (:org_id, :mustpay_user, 'comp_time', 9999, 9999,
   'overtime_conversion', 'otbank-v18-smoke:<STAMP>:poison-statutory-lot', 'active', now(), 'statutory_holiday');
```

The poison lot must never surface in Step 7's settlement rows: must-pay reads
period facts only, and the statutory source is never convertible.

## Step 5 — full-attendance flags (账3)

`GET /api/attendance/summary?userId=<user>&from=<periodStart>&to=<periodEnd>`
as admin:

- case1/case2/case3: `data.fullAttendanceEligible === false` (any leave breaks
  it, even when the pool offset the leave);
- dormant (overtime-only): `data.fullAttendanceEligible === true`.

## Step 6 — settlement population guard (OQ-2)

Before closing the cycle, count the would-be settlement population that is NOT
stamped by this smoke:

```sql
SELECT count(*) AS non_synthetic FROM (
  SELECT user_id FROM attendance_records
    WHERE org_id = :org_id AND work_date BETWEEN :period_start AND :period_end
  UNION
  SELECT user_id FROM attendance_requests
    WHERE org_id = :org_id AND status = 'approved' AND work_date BETWEEN :period_start AND :period_end
  UNION
  SELECT user_id FROM attendance_leave_balances
    WHERE org_id = :org_id AND leave_type_code = 'comp_time' AND status = 'active' AND remaining_minutes > 0
) pop WHERE user_id IS NULL OR left(user_id, length(:user_prefix)) <> :user_prefix;
```

If `non_synthetic > 0`, stop and resolve OQ-2 (dedicated org, or an explicit,
recorded acceptance via `ALLOW_NON_SYNTHETIC_SETTLEMENT_POPULATION=1`).

## Step 7 — cycle close, settlement snapshot, replay, freeze guards

1. As admin: `POST /api/attendance/payroll-cycles`
   `{name:'<STAMP>-cycle', startDate:<periodStart>, endDate:<periodEnd>, status:'open', metadata:{smokeStamp:'<STAMP>'}}` → `201`.
2. Assert (SQL) zero settlement rows exist for the cycle before close.
3. `PUT /api/attendance/payroll-cycles/:id {"status":"closed"}` → `200`.

Backend assertions:

```sql
SELECT user_id, source, convertible_minutes, must_pay_minutes,
       period_start_date, period_end_date, closed_at, snapshot
FROM attendance_payroll_cycle_settlements
WHERE org_id = :org_id AND cycle_id = :cycle_id
ORDER BY user_id, source;
```

Expected:

- case1: no rows (pool fully consumed, workday pooled → zero-zero skipped);
- case2: exactly one row `source='workday'`, `convertible_minutes=300`,
  `must_pay_minutes=0`, `period_start_date`/`period_end_date` equal the cycle
  period, `closed_at` non-null, and `snapshot.overtimeBankPolicy.pooledSources`
  contains `workday`;
- case3: no rows (partial offset exhausted the pool);
- mustpay: exactly one row `source='statutory_holiday'`,
  `must_pay_minutes=480` (period facts), `convertible_minutes=0` — NOT the
  9999 poison;
- dormant: exactly one row `source='legacy_unsourced'`,
  `convertible_minutes=120`, `must_pay_minutes=0`;
- when the population guard reported synthetic-only: exactly 3 rows total.

Then:

4. Replay `PUT {"status":"closed"}` → `200`, and the settlement rows are
   byte-for-byte unchanged (count and values).
5. `PUT {"startDate":<periodStart+1>,"endDate":<periodEnd>}` →
   `409 CYCLE_CLOSED_PERIOD_FROZEN`.
6. `DELETE /api/attendance/payroll-cycles/:id` →
   `409 CYCLE_CLOSED_NOT_DELETABLE` (cleanup therefore uses scoped SQL:
   settlements first — the FK is `ON DELETE RESTRICT` — then the cycle).

## Optional UI probe (v1-6, non-blocking)

In a browser as the admin, open the attendance admin settings surface and
verify the three policy cards (overtime bank / leave offset / full attendance)
render the state this smoke configured, and that the pooled-sources selector
never offers the statutory-holiday source. This probe strengthens the arc but
is not part of the stamped assertion set.

## Step 8 — cleanup and EXPLICIT settings restore

Settings restore first, and never by PUT-ing an empty or partial snapshot:
`PUT /api/attendance/settings` merges per policy key, so an empty-body restore
is a NO-OP that leaks the smoke's policies (the #3303 lesson). Restore with
every touched key explicitly re-asserted:

```json
{
  "...": "<the full pre-smoke settings snapshot spread first>",
  "overtimeSegmentation": { "enabled": false, "...": "<pre-smoke overtimeSegmentation if any>" },
  "compTimeFromOvertime": { "enabled": false, "...": "<pre-smoke compTimeFromOvertime if any>" },
  "overtimeBankPolicy": { "enabled": false, "pooledSources": [], "...": "<pre-smoke overtimeBankPolicy if any>" },
  "leaveBalanceDeductionPolicy": { "enabled": false, "rules": [], "...": "<pre-smoke leaveBalanceDeductionPolicy if any>" },
  "attendanceBonusPolicy": { "enabled": false, "...": "<pre-smoke attendanceBonusPolicy if any>" }
}
```

Then re-GET and verify all five policy keys compare equal (stable JSON) to the
pre-smoke snapshot. A restore that silently leaves `overtimeBankPolicy`
enabled fails the smoke.

Cleanup deletes only stamped/captured rows, in FK-safe order: approval
records/assignments → adjustment events (by captured request ids) → records
(by user prefix) → requests → lots (ledger events cascade) → approval
instances → settlement rows (by cycle id) → cycles → holiday / overtime rule /
leave type fixtures → user_orgs → users.

## Step 9 — residue check

After cleanup, every category must be zero. Use the literal `:stamp` matching
`/^otbank-v18-smoke-[A-Za-z0-9-]+$/`, `:user_prefix = :stamp || '-'`, the
captured `:request_ids` / `:approval_ids` / `:cycle_ids` / fixture ids, and
the exact poison-lot key; do not use an unescaped wildcard stamp for cleanup.

```sql
SELECT
  (SELECT count(*) FROM attendance_requests
    WHERE org_id = :org_id AND (id = ANY(:request_ids::uuid[]) OR left(user_id, length(:user_prefix)) = :user_prefix)) AS requests,
  (SELECT count(*) FROM attendance_records
    WHERE org_id = :org_id AND left(user_id, length(:user_prefix)) = :user_prefix) AS records,
  (SELECT count(*) FROM attendance_events
    WHERE org_id = :org_id AND meta->>'requestId' = ANY(:request_ids::text[])) AS events,
  (SELECT count(*) FROM attendance_leave_balances
    WHERE org_id = :org_id AND (left(user_id, length(:user_prefix)) = :user_prefix OR source_key = :poison_lot_key)) AS leave_balances,
  (SELECT count(*) FROM attendance_leave_balance_events
    WHERE org_id = :org_id AND left(user_id, length(:user_prefix)) = :user_prefix) AS balance_events,
  (SELECT count(*) FROM attendance_leave_types
    WHERE org_id = :org_id AND (id = ANY(:leave_type_ids::uuid[]) OR code = :leave_type_code)) AS leave_types,
  (SELECT count(*) FROM attendance_overtime_rules
    WHERE org_id = :org_id AND (id = ANY(:overtime_rule_ids::uuid[]) OR name = :overtime_rule_name)) AS overtime_rules,
  (SELECT count(*) FROM attendance_holidays
    WHERE org_id = :org_id AND (id = ANY(:holiday_ids::uuid[]) OR name = :holiday_name)) AS holidays,
  (SELECT count(*) FROM attendance_payroll_cycle_settlements
    WHERE org_id = :org_id AND cycle_id = ANY(:cycle_ids::uuid[])) AS settlements,
  (SELECT count(*) FROM attendance_payroll_cycles
    WHERE org_id = :org_id AND (id = ANY(:cycle_ids::uuid[]) OR metadata->>'smokeStamp' = :stamp)) AS cycles,
  (SELECT count(*) FROM approval_instances WHERE id = ANY(:approval_ids::text[])) AS approval_instances,
  (SELECT count(*) FROM approval_assignments WHERE instance_id = ANY(:approval_ids::text[])) AS approval_assignments,
  (SELECT count(*) FROM approval_records WHERE instance_id = ANY(:approval_ids::text[])) AS approval_records,
  (SELECT count(*) FROM attendance_notification_deliveries
    WHERE org_id = :org_id AND left(recipient_user_id, length(:user_prefix)) = :user_prefix) AS deliveries,
  (SELECT count(*) FROM user_orgs
    WHERE org_id = :org_id AND left(user_id, length(:user_prefix)) = :user_prefix) AS user_orgs,
  (SELECT count(*) FROM users WHERE left(id, length(:user_prefix)) = :user_prefix) AS users;
```

The approval-engine categories are counted on purpose: the request
create/approve chain writes `approval_instances` / `approval_assignments` /
`approval_records`, and leaving them behind is a failed smoke, not a harmless
warning. The deliveries category must be zero because this smoke never writes
notification deliveries — a non-zero count means cross-smoke interference in
the bundled window. Do not narrow residue to only the rows that are easy to
delete.

## Expected PASS Stamp

Use this exact shape after all steps pass and the operator-decision blocks are
resolved:

```text
OTBANK_V18_STAGING_SMOKE_PASS deploy=<sha> stamp=<otbank-v18-smoke-...> org=<org> cycle=<uuid> residue=0
```

Backfill text:

> **回填（YYYY-MM-DD OT-bank v1-8 staging closeout）**：staging smoke
> `OTBANK_V18_STAGING_SMOKE_PASS` on deploy `<sha>`（stamp `<stamp>`）：dormant
> bank kept the legacy NULL-source grant; enabled bank granted per-source
> workday lots; owner 三例（600/300/900 leave vs 600 pool）deducted
> 600/300/600 with remaining 0/300/0、real-absence shortfall 0/0/300、满勤
> flag false×3（overtime-only control true）; statutory-holiday OT banked
> nothing and settled as must-pay 480 from period facts（poison 9999 lot never
> surfaced）; cycle close snapshotted convertible 0/300/0 with frozen period
> columns; replay close idempotent; period-change/DELETE 409-frozen; settings
> restored and verified; cleanup residue=0。OQ-1/OQ-2 decisions recorded:
> `<...>`。v1-8 closed ✅（v1-7 payout producer remains gated）。

## On FAIL

- Dormant path grants a per-source lot or an enabled-bank grant appears with
  no segmentation snapshot: the accrual gating regressed; do not pass.
- `pooledSources=['statutory_holiday']` is accepted by PUT: the compliance
  floor regressed; do not pass.
- Replay approve credits a second lot/event: grant idempotency regressed; do
  not pass.
- case3 approve returns `422` instead of approving with a 300 shortfall: the
  `partial_unpaid_absence` mode is not wired; do not pass.
- Full-attendance flag is true for a case user: 账3 reads net-after-offset
  instead of raw leave; do not pass.
- A statutory settlement row shows 9999 or a convertible amount: must-pay is
  being derived from balance lots; do not pass — this is the poison-lot
  invariant.
- Settlement rows change on replay close, or the frozen-period/DELETE guards
  do not return `409`: settlement immutability regressed; do not pass.
- Settings do not compare equal after restore: the #3303 hygiene regressed —
  fix the restore before re-running anything else in the window.
- Residue is nonzero: inspect the stamped rows before re-running.

## Safety

- Uses only synthetic `otbank-v18-smoke-*` users, fixtures, and a far-future
  settlement period chosen to contain zero real facts.
- Saves and restores attendance settings, with an explicit re-assert of every
  touched policy key and a verified compare (never PUTs an empty snapshot).
- Fails closed before cycle close if the settlement population would include
  any non-synthetic user (override is explicit and must be recorded).
- Does not change scheduler flags, worker flags, notification channel
  configuration, or production payroll cycles; never touches deliveries.
- Does not delete by broad source/type text; cleanup is stamped and keyed by
  captured ids; the closed smoke cycle is removed via scoped SQL only
  (settlements first, then the cycle).
