# 年假 / 法定假 L6 — staging end-to-end smoke runbook (residue=0)

**Status:** L6 is the **end-to-end staging smoke** that proves the L0–L5b annual-leave / statutory-annual-leave
(年假 / 法定年假) chain on a **live staging stack** (not a local fixture, not CI), then asserts **residue=0**.
The L0–L4 engine + L5a/L5b admin surfaces are on `origin/main`; the three L5c mutating endpoints
(`annual-leave-accrual/run`, `annual-leave-manual-adjustment`, `annual-leave-expiry-backfill`) are API-only,
each `withPermission('attendance:admin')`, org-scoped via `getOrgId`. This runbook drives all of them plus the
L1 year-end reaper (`AttendanceExpiryService`) and leaves nothing behind.

Refs: balance-engine design-lock `attendance-annual-leave-balance-engine-design-lock-20260615.md` (L0–L6 sub-chain),
admin-UI design-lock `attendance-annual-leave-admin-ui-design-lock-20260616.md` (L5a/L5b/L5c boundary),
the comp-time precedent `attendance-comp-leave-c4-2-staging-smoke-runbook-20260604.md` (scheduler-path smoke
this one mirrors for the L1 reaper).

This is a **staging** runbook: a staging admin token is minted with the **staging** `JWT_SECRET`, never a prod one
(§0). All host IPs, secrets, and DSNs are sanitized placeholders — substitute your own; commit no real values.

---

## 0. Placeholders + preflight auth round-trip (do this FIRST)

> **HARD PREREQUISITE — disposable, single-member smoke org.** `<ORG>` **MUST** be a throwaway org whose **only**
> eligible member is `<EMP>` (exactly one active `user_orgs` row with a tenure anchor — §1 asserts this). This is
> **not** a preference. `runAnnualLeaveAccrual` in §3 grants a lot + event to **every** active member of the org,
> not just `<EMP>`; and the teardown in §8 deletes the org's `annual:<YEAR>` run audit. Running against a shared or
> populated org would therefore (a) grant real annual-leave lots to other live users and (b) orphan their lots'
> provenance when the run rows are deleted. **Do not run this smoke against a shared/production-adjacent org.** If
> you have no disposable org, create one and seed `<EMP>` into it (§1) before proceeding.

Set these once for the session. `<TOKEN>` MUST be an `attendance:admin` JWT **issued by the staging realm**.

```bash
export BASE='<BASE>'            # staging root via your tunnel, e.g. http://127.0.0.1:8082 — NO real host IP in the doc
export ORG='<ORG>'             # the DISPOSABLE single-member smoke org id (HARD prereq above; never a shared org)
export TOKEN='<TOKEN>'         # attendance:admin JWT minted with the STAGING JWT_SECRET
export EMP='<EMP>'             # a seeded, active employee user id (the accrual/adjust subject)
export PGURL='<PGURL>'         # staging postgres DSN reachable via the tunnel; psql "$PGURL" must connect
export SUF="al-l6-$(date +%s)"
H=(-H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -H "x-org-id: $ORG")
```

> **Why the realm matters.** Staging runs a **distinct `JWT_SECRET`** from prod. A prod-minted token presented to
> staging **401s `Invalid token`**. So in this runbook a **401 is a wrong-realm / schema-gap signal, not a code bug** —
> do not "debug the route", re-mint the token in the staging realm (or confirm staging is migrated) and retry.

> **Why the token's org matters (write-routing).** The write endpoints resolve their org via
> `getOrgId = body.orgId ?? query.orgId ?? token.org ?? x-org-id header` — the `x-org-id` header in `$H` is **last**.
> The POSTs here carry no `body.orgId`/`query.orgId`, so **if `<TOKEN>` embeds an org (`orgId`/`workspaceId`), every
> write lands in the token's org**, not `<ORG>` — while §1's gate and §8's teardown operate on `<ORG>` (and the
> `?orgId=<ORG>` reads mask it). **HARD REQUIREMENT:** `<TOKEN>` must be **org-less**, or its embedded org must equal
> `<ORG>`. The §3a dry-run org-match check fails fast on a mismatch **before** any real grant — but use a correct
> token so it never fires.

**Preflight — prove the token authenticates AND the org resolves on staging:**

```bash
curl -s -o /dev/null -w '%{http_code}\n' "${H[@]}" "$BASE/api/attendance/settings"
curl -s "${H[@]}" "$BASE/api/attendance/leave-balances?orgId=$ORG&userId=$EMP&leaveTypeCode=annual" \
  | jq '{ok, code: .error.code}'
```

- **PASS:** the settings probe returns **`200`**, and the L5a read returns **`{ "ok": true, ... }`**
  (an empty-but-valid balance is fine — `summary` present, `activeLots`/`recentEvents` arrays).
- **FAIL → STOP:** any **`401`** here = wrong-realm token (re-mint with the staging secret) **or** a staging schema
  gap (attendance tables surface as `503 DB_NOT_READY`, not a route 404). A `503 DB_NOT_READY` means staging is **not**
  migrated through the L1 ledger DDL — STOP and run the migration-align first; do **not** improvise DDL.

---

## 1. THE GATE — `user_orgs` target-population check (STOP if zero)

The accrual population AND the manual-adjust target guard resolve the **same** way: an active `user_orgs` row
JOINed to an active `users` row. The exact server SQL (verified in `runAnnualLeaveAccrual` / `applyAnnualLeaveManualAdjustment`):

```sql
-- run against the staging DB, with :org bound to <ORG>
SELECT count(*) AS active_members
  FROM user_orgs uo
  JOIN users u ON u.id = uo.user_id
 WHERE uo.org_id = :org AND uo.is_active = true AND u.is_active = true;

-- of those, how many carry a tenure anchor (else accrual SKIPs them with MISSING_SERVICE_START_DATE):
-- cumulative_service mode anchors on cumulative_service_start_date; company_tenure mode anchors on hire_date.
SELECT count(*) AS with_tenure_anchor
  FROM user_orgs uo
  JOIN users u ON u.id = uo.user_id
 WHERE uo.org_id = :org AND uo.is_active = true AND u.is_active = true
   AND (u.cumulative_service_start_date IS NOT NULL OR u.hire_date IS NOT NULL);
```

```bash
psql "$PGURL" -v org="'$ORG'" -c "SELECT count(*) AS active_members FROM user_orgs uo JOIN users u ON u.id = uo.user_id WHERE uo.org_id = :org AND uo.is_active = true AND u.is_active = true;"
psql "$PGURL" -v org="'$ORG'" -c "SELECT count(*) AS with_tenure_anchor FROM user_orgs uo JOIN users u ON u.id = uo.user_id WHERE uo.org_id = :org AND uo.is_active = true AND u.is_active = true AND (u.cumulative_service_start_date IS NOT NULL OR u.hire_date IS NOT NULL);"
```

Also confirm `<EMP>` itself passes the guard (the §5 adjust/404 cases depend on it):

```bash
psql "$PGURL" -v org="'$ORG'" -v emp="'$EMP'" -c "SELECT 1 FROM user_orgs uo JOIN users u ON u.id = uo.user_id WHERE uo.user_id = :emp AND uo.org_id = :org AND uo.is_active = true AND u.is_active = true LIMIT 1;"
```

- **PASS:** `active_members == 1`, `with_tenure_anchor == 1`, and that one member is `<EMP>`. The count **must be
  exactly 1** (the §0 hard prerequisite): a disposable single-member org guarantees §3's accrual grants to `<EMP>`
  **only**, so §8's teardown is precise and cannot touch any other user.
- **`active_members != 1` → STOP, no exception.** There is **no** "throwaway extra members" escape: §8's teardown
  deletes lots/events/adjustments scoped to `<EMP>` only (while it deletes the org's `annual:<YEAR>` run audit
  org-wide). So any **other** active member would be left a **real granted annual lot** (residue ≠ 0) **and** have
  that lot's provenance orphaned when the run rows are deleted — the exact corruption §0 forbids. If the count is
  not exactly 1, you do not have a disposable single-member org; provision one and re-run §1.
- **FAIL → STOP (do not continue to §2):** if **`active_members = 0`** the accrual grants to **nobody**
  (every run-item would be skipped) and **every** manual-adjust **404s `USER_NOT_IN_ORG`** — the rest of the smoke
  cannot prove anything. A member with **no active `user_orgs` row is invisible** to accrual and 404s on adjust;
  seed an active membership (or provision the disposable single-member org of §0/§1) and re-run §1. If
  `with_tenure_anchor = 0` but `active_members == 1`, accrual will run but the item skips `MISSING_SERVICE_START_DATE` — seed an anchor
  on `<EMP>` before §3 so you get a real granted lot.

---

## 2. L5b — enable the policy via `PUT /api/attendance/settings`

Capture the original policy (for teardown), then enable with a **valid IANA timezone** (the engine refuses to
enable without one — `enabled=true` + missing/invalid `timezone` → `422`).

```bash
ORIG_POLICY=$(curl -s "${H[@]}" "$BASE/api/attendance/settings" \
  | jq -c '.data.annualLeavePolicy // {"enabled":false}')
echo "ORIG_POLICY=$ORIG_POLICY"

curl -s "${H[@]}" -X PUT "$BASE/api/attendance/settings" -d '{
  "annualLeavePolicy": {
    "enabled": true,
    "tenureMode": "company_tenure",
    "standardDayMinutes": 480,
    "tiers": [
      {"minYears": 1, "maxYears": 10, "days": 5},
      {"minYears": 10, "maxYears": 20, "days": 10},
      {"minYears": 20, "maxYears": null, "days": 15}
    ],
    "carryover": {"enabled": false},
    "timezone": "Asia/Shanghai"
  }
}' | jq '.data.annualLeavePolicy // .error'
```

> `tenureMode: "company_tenure"` anchors tenure on `hire_date`, so a freshly seeded employee with a `hire_date`
> but no `cumulative_service_start_date` still accrues. If your seed instead populated `cumulative_service_start_date`,
> use `"cumulative_service"`.

**Negative control (the timezone guard is real):**

```bash
curl -s -o /dev/null -w '%{http_code}\n' "${H[@]}" -X PUT "$BASE/api/attendance/settings" \
  -d '{"annualLeavePolicy":{"enabled":true,"timezone":"Not/AZone"}}'   # expect 422
```

- **PASS:** the enable returns the saved policy with `"enabled": true` and `"timezone": "Asia/Shanghai"`; the
  negative control returns **`422`** (`ANNUAL_LEAVE_TIMEZONE_REQUIRED` for a missing tz, `ANNUAL_LEAVE_TIMEZONE_INVALID`
  for a typo). **Re-apply the valid enable** after the negative control so §3 runs against an enabled policy.
- **FAIL:** a `200` on the typo (the guard regressed) or a `422` on the valid enable (timezone resolver broken).

---

## 3. L5c accrual — dry-run THEN real (assert dry-run residue + real grant + idempotent re-run)

The accrual run **always** writes a run + run_items (audit). `dryRun:true` writes **NO lots and NO events** and
**consumes no `source_key`**; the real run grants lots; a second real run is **idempotent**.

```bash
PERIOD=2026

# 3a — DRY RUN: persists run + run_items, but creates NO lots/events
DRY=$(curl -s "${H[@]}" -X POST "$BASE/api/attendance/annual-leave-accrual/run" \
  -d "{\"period\":$PERIOD,\"dryRun\":true}")
echo "$DRY" | jq '.data | {runId, periodKey, dryRun, granted, skipped, grantedMinutes, lotsCreated, alreadyGranted, skipReasons}'
DRY_RUN_ID=$(echo "$DRY" | jq -r '.data.runId')
```

**Assert the dry-run left no lots/events** (only the run/run_items audit rows):

```bash
psql "$PGURL" -v org="'$ORG'" -v emp="'$EMP'" -c "SELECT count(*) AS dry_lots FROM attendance_leave_balances WHERE org_id = :org AND user_id = :emp AND leave_type_code = 'annual' AND source_type = 'annual_accrual';"
# org-match gate (P1: getOrgId precedence): the run row MUST be found UNDER :org. The write resolves its org via
# getOrgId = body.orgId ?? query.orgId ?? token.org ?? x-org-id header — the header is LAST, so a token carrying a
# different org would route this write elsewhere. Filtering `AND org_id = :org` makes a mismatch return 0 rows here,
# on the DRY run, BEFORE §3b grants any real lot.
psql "$PGURL" -v org="'$ORG'" -v rid="'$DRY_RUN_ID'" -c "SELECT dry_run, (SELECT count(*) FROM attendance_leave_accrual_run_items WHERE run_id = :rid) AS items FROM attendance_leave_accrual_runs WHERE id = :rid AND org_id = :org;"
```

- **PASS (3a):** `data.dryRun = true`, `granted >= 1` (the computed-grantable count a preview reports),
  `lotsCreated = 0`, `alreadyGranted = 0`; `dry_lots = 0` (NO real lot from the dry-run); the run row is **found
  under `<ORG>`** (the `AND org_id = :org` query returns a row) with `dry_run = t` and `items >= 1`. Note
  `skipReasons` is an **object/map** (`reasonCode → count`), not an array.
- **FAIL → STOP before §3b:** the run-row query returns **no row** → the write landed in a **different org** than
  `<ORG>` (the `<TOKEN>` carries an embedded org that overrides the `x-org-id` header via `getOrgId` precedence; §0).
  Do **not** proceed to the real grant — re-mint an org-less token (or one whose org is `<ORG>`) and restart §3.

```bash
# 3b — REAL RUN: grants the lots + grant events
REAL=$(curl -s "${H[@]}" -X POST "$BASE/api/attendance/annual-leave-accrual/run" \
  -d "{\"period\":$PERIOD,\"dryRun\":false}")
echo "$REAL" | jq '.data | {dryRun, granted, grantedMinutes, lotsCreated, alreadyGranted, skipReasons}'
REAL_RUN_ID=$(echo "$REAL" | jq -r '.data.runId')   # informational only — §8 teardown is period_key-scoped and intentionally catches the dry/real/re-run rows together
```

```bash
# 3c — RE-RUN (real): idempotent by (org, period) source_key — no double-grant
RERUN=$(curl -s "${H[@]}" -X POST "$BASE/api/attendance/annual-leave-accrual/run" \
  -d "{\"period\":$PERIOD,\"dryRun\":false}")
echo "$RERUN" | jq '.data | {lotsCreated, alreadyGranted}'
```

- **PASS (3b):** `dryRun = false`, `granted == 1` and `lotsCreated == 1` (the single-member org → **exactly** `<EMP>`
  is granted; if `granted > 1` the org was not disposable-single-member — STOP per §0/§1), `grantedMinutes > 0`
  (e.g. one 5-day employee → `5 × 480 = 2400`).
- **PASS (3c):** the re-run reports `lotsCreated = 0` and `alreadyGranted >= 1` — the `annual_accrual:{user}:annual:2026`
  `source_key` (`ON CONFLICT (org_id, source_key) DO NOTHING`) makes it a **no-op**; **no second lot** is created.
- **FAIL:** dry-run `lotsCreated > 0` or `dry_lots > 0`; real run `lotsCreated = 0` with `<EMP>` eligible
  (check §1 anchor); a re-run that creates a second lot (idempotency broken).

---

## 4. L5a — balance read confirms the granted lots + ledger

```bash
# The response is { ok, data: { summary, activeLots, recentEvents } } — read everything under .data
# (a top-level `.summary` is null and would silently NOT trip a fallback).
curl -s "${H[@]}" "$BASE/api/attendance/leave-balances?orgId=$ORG&userId=$EMP&leaveTypeCode=annual" \
  | jq '.data | {summary, activeLotCount: (.activeLots|length), eventTypes: (.recentEvents|map(.event_type)|unique)}'
```

- **PASS:** `summary.grantedMinutes == summary.remainingMinutes` and equals the §3b `grantedMinutes` for `<EMP>`
  (e.g. `2400`); `summary.exhaustedMinutes = 0`, `summary.expiredMinutes = 0`; at least one `active` lot with
  `source_type = 'annual_accrual'`; `recentEvents` contains a `grant` event. The balance is **explainable**
  (lots + ledger present), per the L5a 口径.
- **FAIL:** `remainingMinutes` ≠ `grantedMinutes` with no deduction in the ledger; or empty `activeLots` after §3b.

---

## 5. L5c manual-adjust — write, idempotent replay, 409, 422, 404

`POST /api/attendance/annual-leave-manual-adjustment` body `{userId, deltaMinutes (int32 nonzero), reason (1–500),
idempotencyKey? (1–200), runId? (uuid)}`. No server dry-run. `idempotencyKey → source_key` makes a retry a no-op;
positive → new lot + grant event; negative → FIFO-deduct across active lots; the whole txn (incl. the registry row)
rolls back on failure.

```bash
IDK="$SUF-adj1"

# 5a — first write (positive +240 = half a standard day)
A1=$(curl -s "${H[@]}" -X POST "$BASE/api/attendance/annual-leave-manual-adjustment" \
  -d "{\"userId\":\"$EMP\",\"deltaMinutes\":240,\"reason\":\"L6 smoke +240\",\"idempotencyKey\":\"$IDK\"}")
echo "$A1" | jq '.data'
# capture the ADJUSTMENT id: the positive lot's source_id = this id, and its source_key = annual_manual_adjust:<ADJ_ID>
# (the REGISTRY row's source_key is annual_manual_adjust:<idempotencyKey> — a different key), so proving "no second
# lot/event on replay" must key on ADJ_ID, not $IDK.
ADJ_ID=$(echo "$A1" | jq -r '.data.id')

# 5b — idempotency replay: SAME key + SAME payload → no-op (no second lot/event)
A2=$(curl -s "${H[@]}" -X POST "$BASE/api/attendance/annual-leave-manual-adjustment" \
  -d "{\"userId\":\"$EMP\",\"deltaMinutes\":240,\"reason\":\"L6 smoke +240\",\"idempotencyKey\":\"$IDK\"}")
echo "$A2" | jq '.data'

# 5c — same key, DIFFERENT payload → 409 conflict
echo "5c http:"; curl -s -o /dev/null -w '%{http_code}\n' "${H[@]}" -X POST "$BASE/api/attendance/annual-leave-manual-adjustment" \
  -d "{\"userId\":\"$EMP\",\"deltaMinutes\":300,\"reason\":\"different amount\",\"idempotencyKey\":\"$IDK\"}"

# 5d — negative beyond balance → 422 (whole txn, incl. registry row, rolls back)
HUGE=$(( -999999 ))
echo "5d body:"; curl -s "${H[@]}" -X POST "$BASE/api/attendance/annual-leave-manual-adjustment" \
  -d "{\"userId\":\"$EMP\",\"deltaMinutes\":$HUGE,\"reason\":\"insufficient probe\",\"idempotencyKey\":\"$SUF-neg\"}" \
  | jq '{ok, code: .error.code}'

# 5e — non-member target → 404 USER_NOT_IN_ORG (use a user id NOT in <ORG>; substitute a real-but-foreign id)
echo "5e body:"; curl -s "${H[@]}" -X POST "$BASE/api/attendance/annual-leave-manual-adjustment" \
  -d "{\"userId\":\"00000000-0000-0000-0000-000000000000\",\"deltaMinutes\":60,\"reason\":\"non-member\",\"idempotencyKey\":\"$SUF-nomember\"}" \
  | jq '{ok, code: .error.code}'
```

Confirm the replay created **no second lot and no second event** (keyed on the adjustment id, not `$IDK`):

```bash
# the replay must return the SAME adjustment id with applied=false / alreadyApplied=true
echo "$A2" | jq -e --arg id "$ADJ_ID" '.data.id == $id and .data.applied == false and .data.alreadyApplied == true' >/dev/null \
  && echo "5b replay: same id, no-op" || echo "5b FAIL: replay id/flags mismatch"
# exactly ONE registry row (keyed on idempotencyKey) ...
psql "$PGURL" -v org="'$ORG'" -v key="'annual_manual_adjust:$IDK'" -c "SELECT count(*) AS adj_rows FROM attendance_leave_manual_adjustments WHERE org_id = :org AND source_key = :key;"
# ... AND exactly ONE lot (source_id = the adjustment id) AND exactly ONE annual_manual_adjust grant event for <EMP>
psql "$PGURL" -v org="'$ORG'" -v adjid="'$ADJ_ID'" -c "SELECT count(*) AS adj_lots FROM attendance_leave_balances WHERE org_id = :org AND source_type = 'annual_manual_adjust' AND source_id = :adjid;"
psql "$PGURL" -v org="'$ORG'" -v emp="'$EMP'" -c "SELECT count(*) AS adj_events FROM attendance_leave_balance_events WHERE org_id = :org AND user_id = :emp AND source_type = 'annual_manual_adjust';"
psql "$PGURL" -v org="'$ORG'" -v key="'annual_manual_adjust:$SUF-neg'" -c "SELECT count(*) AS rolled_back_rows FROM attendance_leave_manual_adjustments WHERE org_id = :org AND source_key = :key;"
```

- **PASS (5a):** `data.applied = true`, `data.alreadyApplied = false`, `data.delta = 240`; a new
  `annual_manual_adjust` lot + grant event exist.
- **PASS (5b):** the replay returns the **same** `data.id` with `data.applied = false`, `data.alreadyApplied = true`,
  same `data.delta = 240`; and **`adj_rows = 1` AND `adj_lots = 1` AND `adj_events = 1`** — the replay created no
  second registry row, **no second lot, and no second event**. (`adj_lots`/`adj_events` are the load-bearing checks;
  `adj_rows` alone would not catch a duplicate lot, since the lot is keyed on the adjustment id, not the idempotency key.)
- **PASS (5c):** HTTP **`409`** (`ANNUAL_LEAVE_ADJUST_IDEMPOTENCY_CONFLICT`) — same key, different payload is
  rejected loudly, not silently no-op'd.
- **PASS (5d):** `ok=false`, `code = ANNUAL_LEAVE_BALANCE_INSUFFICIENT`, HTTP `422`; `rolled_back_rows = 0`
  (the failed adjustment left **no** registry row — the whole txn rolled back).
- **PASS (5e):** `ok=false`, `code = USER_NOT_IN_ORG`, HTTP `404` (target not an active `user_orgs` member of `<ORG>`).
- **FAIL:** a replay that creates a second lot/row; a `200` on 5c/5d/5e; a residual registry row after 5d.

> Also exercised by the schema, not separately stepped: `deltaMinutes:0 → 400 ANNUAL_LEAVE_ADJUST_DELTA_INVALID`.

---

## 6. L5c expiry-backfill — dry-run auditable summary

`POST /api/attendance/annual-leave-expiry-backfill` body `{dryRun?}`. It backfills `expires_at` for pre-L4a
`annual_accrual` lots (NULL expiry) from each lot's **accrual-run provenance** (not today's settings), and returns
an auditable summary `{scanned, updated, skipped, reasons}` where **`reasons` is an object/map** (`reasonCode → count`),
not an array. The §3b lots were granted with an expiry already (L4a stamps it at grant), so a healthy backfill
typically **scans them and finds nothing to update** — that is the expected, auditable result here.

```bash
curl -s "${H[@]}" -X POST "$BASE/api/attendance/annual-leave-expiry-backfill" -d '{"dryRun":true}' \
  | jq '.data | {scanned, updated, skipped, dryRun, reasons}'
```

- **PASS:** `dryRun = true`; `scanned >= 0`; `updated` counts only would-be NULL→stamped rows; `skipped` +
  `reasons` account for the rest (e.g. `{"ALREADY_SET": n}` is not used in dry-run; in dry-run `updated` is the
  would-update count). The summary is **fully accounted**: `scanned == updated + skipped`. Because it is `dryRun:true`,
  the DB is untouched (verified in §8 residue).
- **FAIL:** a `reasons` array instead of an object; or `scanned != updated + skipped`.

---

## 7. L1 year-end reaper — exercise `AttendanceExpiryService` (NOT a routes-only check)

The L1 reaper lives in `packages/core-backend/src/services/AttendanceExpiryService.ts` (the **scheduler**, not the
plugin route). A routes-only smoke does **not** cover it. To prove the deployed reaper path end to end, the staging
backend must run with the scheduler **on and fast** (same env as the comp-time C4-2 smoke):

```
ATTENDANCE_SCHEDULER_ENABLED=true
ATTENDANCE_SCHEDULER_INTERVAL_MS=5000     # 5 s floor — so the smoke doesn't wait an hour
```

Age the §3b annual lot past expiry, then let the **background scheduler** reap it (do not call a route — that is the
whole point):

```bash
psql "$PGURL" -v org="'$ORG'" -v emp="'$EMP'" -c "UPDATE attendance_leave_balances SET expires_at = now() - interval '1 hour' WHERE org_id = :org AND user_id = :emp AND leave_type_code = 'annual' AND source_type = 'annual_accrual' AND status = 'active';"
sleep 12      # > one ATTENDANCE_SCHEDULER_INTERVAL_MS (5 s) + margin; the background reaper ticks

psql "$PGURL" -v org="'$ORG'" -v emp="'$EMP'" -c "SELECT b.status, b.remaining_minutes,
    (SELECT count(*) FROM attendance_leave_balance_events e WHERE e.balance_id = b.id AND e.event_type = 'expire') AS expire_events,
    (SELECT string_agg(e.source_type, ',') FROM attendance_leave_balance_events e WHERE e.balance_id = b.id AND e.event_type = 'expire') AS expire_source
  FROM attendance_leave_balances b
  WHERE b.org_id = :org AND b.user_id = :emp AND b.leave_type_code = 'annual' AND b.source_type = 'annual_accrual';"

sleep 12      # a second interval — prove the tick is idempotent
psql "$PGURL" -v org="'$ORG'" -v emp="'$EMP'" -c "SELECT count(*) AS expire_events FROM attendance_leave_balance_events e JOIN attendance_leave_balances b ON b.id = e.balance_id WHERE b.org_id = :org AND b.user_id = :emp AND b.leave_type_code = 'annual' AND b.source_type = 'annual_accrual' AND e.event_type = 'expire';"
```

- **PASS:** the aged lot flips to `status = expired`, `remaining_minutes = 0`, with exactly **one** `expire` event
  whose `source_type = annual_leave_expiry` (the annual-typed expiry tag the service derives per `leave_type_code`),
  **driven by the deployed background scheduler** — not by any route call. The second-interval re-check still shows
  exactly **one** expire event (idempotent: events bind to the UPDATE RETURNING, so a repeat tick writes 0).
- **FAIL:** lot still `active` after the interval (scheduler off / not deployed — check `ATTENDANCE_SCHEDULER_ENABLED`
  and the startup log `Attendance scheduler starting with interval 5000ms`); `comp_time_expiry` instead of
  `annual_leave_expiry`; or a second expire event on the repeat tick.

> If staging cannot run the scheduler at a 5 s interval for this smoke, this step is **not satisfied** by calling a
> plugin route — the L1 path is the scheduler. Either enable the fast scheduler or mark L6 **incomplete** for the
> reaper and report it; do not green it from routes alone.

---

## 8. Residue=0 verification + teardown

Two residue claims to prove: (a) the **dry-runs** (§3a accrual dry-run, §6 backfill dry-run) left **no lots/events**;
(b) after teardown the smoke leaves **zero** annual lots/events/runs/adjustments and the policy is **restored**.

**(a) dry-run residue — already asserted inline:** §3a `dry_lots = 0` (the accrual dry-run created no real lot,
consumed no `source_key`, wrote only run/run_items audit), and §6 ran `dryRun:true` (no `expires_at` mutation).
The only real DB mutations this smoke makes are §3b/§3c (one accrual lot+event), §5a (one adjust lot+event),
and §7 (the expiry of that accrual lot) — every one is removed below.

**(b) teardown** — delete the smoke's annual rows for `<EMP>` in `<ORG>`, drop the dry-run + real run audit rows,
and restore the original policy:

```bash
psql "$PGURL" -v org="'$ORG'" -v emp="'$EMP'" <<'SQL'
-- ledger events for this org/user's annual smoke lots
DELETE FROM attendance_leave_balance_events
 WHERE balance_id IN (
   SELECT id FROM attendance_leave_balances
    WHERE org_id = :org AND user_id = :emp AND leave_type_code = 'annual'
      AND source_type IN ('annual_accrual','annual_manual_adjust'));
-- the lots themselves
DELETE FROM attendance_leave_balances
 WHERE org_id = :org AND user_id = :emp AND leave_type_code = 'annual'
   AND source_type IN ('annual_accrual','annual_manual_adjust');
-- the manual-adjust registry rows
DELETE FROM attendance_leave_manual_adjustments
 WHERE org_id = :org AND user_id = :emp AND leave_type_code = 'annual';
-- the accrual run audit (dry + real); run_items cascade or are deleted by run_id
DELETE FROM attendance_leave_accrual_run_items
 WHERE run_id IN (SELECT id FROM attendance_leave_accrual_runs WHERE org_id = :org AND period_key = 'annual:2026');
DELETE FROM attendance_leave_accrual_runs
 WHERE org_id = :org AND period_key = 'annual:2026';
SQL

# restore the original policy captured in §2
curl -s "${H[@]}" -X PUT "$BASE/api/attendance/settings" \
  -d "$(jq -cn --argjson p "$ORIG_POLICY" '{annualLeavePolicy:$p}')" | jq '.data.annualLeavePolicy'

# final residue assertion — all four annual tables clean for this org/user
psql "$PGURL" -v org="'$ORG'" -v emp="'$EMP'" -c "SELECT
   (SELECT count(*) FROM attendance_leave_balances WHERE org_id=:org AND user_id=:emp AND leave_type_code='annual') AS lots,
   (SELECT count(*) FROM attendance_leave_balance_events WHERE org_id=:org AND user_id=:emp AND source_type IN ('annual_accrual','annual_manual_adjust','annual_leave_expiry')) AS events,
   (SELECT count(*) FROM attendance_leave_manual_adjustments WHERE org_id=:org AND user_id=:emp AND leave_type_code='annual') AS adjustments,
   (SELECT count(*) FROM attendance_leave_accrual_runs WHERE org_id=:org AND period_key='annual:2026') AS runs;"
```

- **PASS:** `lots = 0`, `events = 0`, `adjustments = 0`, `runs = 0`, and the policy is restored to `ORIG_POLICY`.

> **This teardown is correct ONLY because §0/§1 mandate a disposable single-member org.** Since `<ORG>` has exactly
> one member (`<EMP>`), every annual lot, event, manual-adjustment, and `annual:<YEAR>` run in it belongs to this
> smoke — so the `<EMP>`-scoped lot/event/adjustment deletes cover everything §3/§5 created, and the org-scoped run
> deletion cannot orphan any other tenant's accrual provenance. **There is no shared-org fallback** (per §0): against
> a populated org, §3's accrual would have granted real lots to other live users that this teardown never removes,
> and deleting the org's `annual:<YEAR>` runs would strip *their* lots' provenance. Do not widen the org/member scope.

---

## 9. Overall PASS bar

L6 is **PASS** only when **all** hold on a live staging run:

1. **§0** preflight — staging-realm token authenticates (`200`), L5a read `ok:true`; no `401`/`503`.
2. **§1 THE GATE** — `active_members == 1` (the disposable single-member org), `with_tenure_anchor == 1`, and that
   member is `<EMP>`. (Any count other than exactly 1 → **STOP, no exception** — the `<EMP>`-scoped teardown does not
   clean other members, so >1 means residue + orphaned provenance.)
3. **§2** policy enabled with a valid IANA timezone; the missing/invalid-timezone control `422`s.
4. **§3** accrual dry-run persists run+run_items but **no lots/events** (`dry_lots = 0`); real run grants
   (`lotsCreated >= 1`); re-run is idempotent (`alreadyGranted >= 1`, no second lot).
5. **§4** L5a read shows the granted lot(s) + a `grant` ledger event; `granted == remaining`.
6. **§5** manual-adjust: write applies; same-key+same-payload replay is a no-op (same `id`, `alreadyApplied:true`)
   proven to add **no second lot/event** (`adj_lots = 1`, `adj_events = 1`, not merely one registry row);
   same-key+different-payload → `409`; negative-insufficient → `422` with the whole txn (incl. registry) rolled back;
   non-member target → `404 USER_NOT_IN_ORG`.
7. **§6** backfill dry-run returns an auditable `{scanned, updated, skipped, reasons}` with `reasons` an **object/map**
   and `scanned == updated + skipped`.
8. **§7** L1 reaper — the **deployed `AttendanceExpiryService`** (not a route) expires the aged lot once with a
   single `annual_leave_expiry` event; a repeat tick adds none.
9. **§8 residue=0** — dry-runs left nothing; teardown leaves `lots/events/adjustments/runs = 0` and restores the policy.

Any STOP at §0 or §1, or any FAIL above, blocks L6 — fix and re-run from §0. When all nine hold, record the
staging build SHA + the run output here, and the L6 row in the balance-engine design-lock (§6) goes **✅**.
