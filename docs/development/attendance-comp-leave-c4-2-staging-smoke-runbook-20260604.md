# ④ C4-2 staging smoke runbook + CI evidence (comp-time expiry scheduler)

**Status:** C4-2 code is **merged** (#2274, merge commit `4b3108737`, on `origin/main`); CI is
**fresh-green** and the attendance DB step genuinely ran the C4 spec (evidence §2). The **staging C4 smoke
PASSED on 2026-06-04** after deploying build `8701c46e00c68ed19c226e7206f5456866f6b8ba` to staging
(`https://23.254.236.11/`) with `ATTENDANCE_SCHEDULER_ENABLED=true` and
`ATTENDANCE_SCHEDULER_INTERVAL_MS=5000`. Per the #2267 design-lock and #2230 governing
("`④ C4 ✅` is gated on C4-2 + a staging C4 smoke"), **④ C4 is now ✅**.

Refs: #2274 (C4-2 impl), #2270 (C4-1 inert expiry fn), #2267 (C4 execution design-lock),
#2230 (④ governing design-lock), #2226 (staging migration-align runbook — the hard prereq).

---

## 1. What merged (scope check — matches the locked C4-2 scope, no scope creep)

`#2274` (6 files, +620/-10):

- `packages/core-backend/src/services/AttendanceScheduler.ts` — env-gated (`ATTENDANCE_SCHEDULER_ENABLED`,
  default OFF), `unref` interval tick + one-run guard, opt-in Redis leader lock
  (`ENABLE_ATTENDANCE_SCHEDULER_LEADER_LOCK`, load-only — the expiry claim is self-guarding), interval via
  `ATTENDANCE_SCHEDULER_INTERVAL_MS` (default 1h, floor 5s). Mirrors `ApprovalSlaScheduler`.
- `packages/core-backend/src/services/AttendanceNotifier.ts` — **scaffold only**, registers **no** channels,
  no-op dispatch (channel-env-gating discipline). No messages — reminders are C5.
- `packages/core-backend/src/index.ts` — startup/shutdown wiring next to `startApprovalSlaScheduler`.
- `plugins/plugin-attendance/index.cjs` — the C2 grant stamps `expires_at = granted_at + N×24h` (fixed
  duration, SQL `now()`-computed) **iff** `compTimeFromOvertime.expiresInDays = N` (positive int) and
  `enabled`; otherwise `expires_at = NULL` (C2 behaviour unchanged, no backfill).
- `tests/unit/attendance-scheduler.test.ts` + `tests/integration/attendance-plugin.test.ts` — see §2.

**No migration / no new DDL** in C4-2: `expires_at` is the C2 column, the ledger tables are C1 (#2231).
This matters for staging: C4-2 is a **pure image bump** on top of an already-C1/C2/C3-migrated staging.

---

## 2. CI evidence — the attendance DB step really ran the C4 spec (not skipped)

The matrix `test (18.x)` / `test (20.x)` jobs of **Plugin System Tests** (`plugin-tests.yml`) have a
dedicated **`Run attendance integration tests`** step (NOT `|| true` — blocking) with a
`: "${DATABASE_URL:?...}"` hard-guard and `ATTENDANCE_TEST_DATABASE_URL` pointed at a real postgres-14, so
`attendance-plugin.test.ts` runs under `describe` (not `describe.skip`). Both node versions ran it.

`#2274` run `26945820453`, job `test (20.x)` (`79498395042`) log:

```
✓ tests/integration/attendance-expiry-service.test.ts (1 test) 48ms
✓ tests/integration/attendance-plugin.test.ts (88 tests) 7782ms
  Test Files  2 passed (2)
```

The C4 assertions are these two cases, both green:

- `attendance-plugin.test.ts:3148` — `it('④ C4 — grant stamps expires_at iff expiresInDays set; scheduler
  tick expires aged lots once (NULL/future survive)')`: covers grant→`expires_at = granted_at + 720h`
  (exact, `expiresInDays=30`), `expiresInDays=null → NULL`, future/NULL survive a scan, aged lot expires
  once (`remaining=0` + one `expire` event `delta=-120, source_type=comp_time_expiry`), repeat tick =
  no second event (idempotent).
- `attendance-expiry-service.test.ts:17` (C4-1) — `it('expires active lots once and leaves NULL, future,
  and spent lots untouched')`.

> Caveat (honest): the CI test instantiates its **own** `AttendanceScheduler` + `AttendanceExpiryService`
> against the test pool and calls `tick()` directly. It proves the **expiry state-flow + idempotency + the
> grant wiring**. It does **not** exercise the **deployed env-gated background scheduler** (startup wiring →
> `ATTENDANCE_SCHEDULER_ENABLED` → periodic tick). That gap is exactly what the staging smoke below closes.

Other gates on #2274: `migration-replay`, `coverage`, `contracts (openapi/strict/dashboard)`, `e2e`,
`after-sales integration`, `K3 WISE offline PoC`, `DingTalk P4 ops regression` — all pass.

---

## 3. Staging smoke result — PASS (2026-06-04)

The previous network blocker was resolved by the new staging IP (`https://23.254.236.11/`). The smoke then ran
against the live staging stack, not a local fixture:

- Public health: `https://23.254.236.11/health` returned `healthy`.
- SSH target: `mainuser@23.254.236.11` (`racknerd-0de8668`).
- Staging repo / compose project: `/home/mainuser/metasheet2-dingtalk-staging` /
  `metasheet2-dingtalk-staging`.
- Migration state before smoke: `kysely_migration` count `177`; C1 tables
  `attendance_leave_balances` / `attendance_leave_balance_events` present; C1 columns including `expires_at`,
  `granted_at`, `remaining_minutes`, and `source_key` present.
- Deployed build: `8701c46e00c68ed19c226e7206f5456866f6b8ba` (contains #2274).
- Scheduler env in the staging backend: `ATTENDANCE_SCHEDULER_ENABLED=true`,
  `ATTENDANCE_SCHEDULER_INTERVAL_MS=5000`.
- Startup log evidence: `Attendance scheduler initialized` and
  `Attendance scheduler starting with interval 5000ms`.

Smoke output:

```text
PASS: backend build is 8701c46e
ORIG_COMP={"enabled":false,"expiresInDays":null}
PASS: enabled compTimeFromOvertime expiresInDays=30
OT_RULE=f92ad711-1703-4da9-8e79-5fe7d76f8579
OT_REQ=f1f5ace0-763e-44c4-bb70-be2fc589a0d7 source_key=overtime_conversion:f1f5ace0-763e-44c4-bb70-be2fc589a0d7
PASS: 30d grant exact: lot=0b92579c-049a-4e49-a52e-df1baa6d3e85 remaining=120 exact_720h=true
OT_NULL=430cfc0d-0f2d-4125-bd7b-77e11bb4eda7 source_key=overtime_conversion:430cfc0d-0f2d-4125-bd7b-77e11bb4eda7
PASS: null-expiry control remains NULL
PASS: background scheduler expired aged lot once: expired|0|1|-120:comp_time_expiry
PASS: NULL lot survived scheduler scan
PASS: repeat scheduler tick is idempotent
PASS: cleanup residue=0 and settings restored
C4_STAGING_SMOKE_PASS commit=8701c46e00c68ed19c226e7206f5456866f6b8ba lot=0b92579c-049a-4e49-a52e-df1baa6d3e85 ot=f1f5ace0-763e-44c4-bb70-be2fc589a0d7 null_ot=430cfc0d-0f2d-4125-bd7b-77e11bb4eda7
```

This closes the §2 caveat: CI already proved the expiry SQL + grant wiring; this staging run proves the
deployed env-gated background scheduler path (`index.ts` startup → scheduler env → periodic tick →
`AttendanceExpiryService`) end to end.

---

## 4. Procedure (run from a host with the staging tunnel + psql on the staging DB)

### 4.0 Deploy prerequisite (owner)

Deploy `4b3108737` (or any later `main`) to staging `:8082` with the scheduler **on** and **fast**:

```
ATTENDANCE_SCHEDULER_ENABLED=true
ATTENDANCE_SCHEDULER_INTERVAL_MS=5000        # 5 s floor — so the smoke doesn't wait an hour
# (leave ENABLE_ATTENDANCE_SCHEDULER_LEADER_LOCK unset — single staging instance, not needed)
```

Because C4-2 adds **no DDL**, this is a pure image bump provided staging is already migrated through
C1–C3 (the #2226 align + the C1 #2231 ledger DDL). If staging is **not** through C1–C3, that is a
*different, heavier* blocker (run the #2226 align + C1 DDL first) — STOP and report it; do not improvise DDL.

Set these once for the session (staging admin token = minted with the **staging** `JWT_SECRET`; a prod token
401s on staging):

```bash
export BASE='http://127.0.0.1:8082'          # staging root via your tunnel
export TOKEN='<staging-admin-jwt>'           # attendance:read,write,admin
export PGURL='<staging-postgres-dsn>'        # reachable via the tunnel; psql "$PGURL" must connect
export SUF="c4smoke-$(date +%s)"
H=(-H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json')
ORIG_COMP_TIME=$(curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/attendance/settings" \
  | jq -c '.data.compTimeFromOvertime // {"enabled":false,"expiresInDays":null}')
echo "ORIG_COMP_TIME=$ORIG_COMP_TIME"
```

### 4.1 Enable expiry + create an OT rule

```bash
curl -s "${H[@]}" -X PUT "$BASE/api/attendance/settings" \
  -d '{"compTimeFromOvertime":{"enabled":true,"expiresInDays":30}}' | jq .

OT_RULE=$(curl -s "${H[@]}" -X POST "$BASE/api/attendance/overtime-rules" \
  -d "{\"name\":\"$SUF-ot\",\"minMinutes\":30}" | jq -r '.data.id')
echo "OT_RULE=$OT_RULE"
```

### 4.2 Grant a 30-day lot (OT request → approve = the C2 grant)

```bash
OT_REQ=$(curl -s "${H[@]}" -X POST "$BASE/api/attendance/requests" \
  -d "{\"workDate\":\"2026-09-25\",\"requestType\":\"overtime\",\"overtimeRuleId\":\"$OT_RULE\",\"minutes\":120}" \
  | jq -r '.data.request.id')
curl -s "${H[@]}" -X POST "$BASE/api/attendance/requests/$OT_REQ/approve" -d '{"comment":"c4 smoke"}' | jq '.status? // .'
echo "OT_REQ=$OT_REQ  source_key=overtime_conversion:$OT_REQ"
```

### 4.3 Assert the grant stamped `expires_at = granted_at + exactly 720 h`

```bash
psql "$PGURL" -c "SELECT id, user_id, status, remaining_minutes, expires_at,
  (expires_at - granted_at = interval '720 hours') AS exact_30d
  FROM attendance_leave_balances WHERE source_key = 'overtime_conversion:$OT_REQ';"
```
**PASS:** one row, `status=active`, `remaining_minutes=120`, `expires_at` NOT NULL, `exact_30d = t`.

### 4.4 Null-expiry control — grant with `expiresInDays=null` keeps `expires_at` NULL

```bash
curl -s "${H[@]}" -X PUT "$BASE/api/attendance/settings" \
  -d '{"compTimeFromOvertime":{"enabled":true,"expiresInDays":null}}' >/dev/null
OT_NULL=$(curl -s "${H[@]}" -X POST "$BASE/api/attendance/requests" \
  -d "{\"workDate\":\"2026-09-26\",\"requestType\":\"overtime\",\"overtimeRuleId\":\"$OT_RULE\",\"minutes\":60}" \
  | jq -r '.data.request.id')
curl -s "${H[@]}" -X POST "$BASE/api/attendance/requests/$OT_NULL/approve" -d '{"comment":"c4 null"}' >/dev/null
psql "$PGURL" -c "SELECT expires_at FROM attendance_leave_balances WHERE source_key = 'overtime_conversion:$OT_NULL';"
```
**PASS:** `expires_at` is NULL.

### 4.5 Age the 30-day lot past expiry, then let the **deployed scheduler** expire it

```bash
psql "$PGURL" -c "UPDATE attendance_leave_balances SET expires_at = now() - interval '1 hour'
  WHERE source_key = 'overtime_conversion:$OT_REQ';"
sleep 12     # > one ATTENDANCE_SCHEDULER_INTERVAL_MS (5 s) + margin; the background scheduler ticks
psql "$PGURL" -c "SELECT b.status, b.remaining_minutes,
    (SELECT count(*) FROM attendance_leave_balance_events e
       WHERE e.balance_id = b.id AND e.event_type = 'expire') AS expire_events,
    (SELECT string_agg(e.delta_minutes::text || ':' || e.source_type, ',')
       FROM attendance_leave_balance_events e
       WHERE e.balance_id = b.id AND e.event_type = 'expire') AS expire_detail
  FROM attendance_leave_balances b WHERE b.source_key = 'overtime_conversion:$OT_REQ';"
```
**PASS:** `status=expired`, `remaining_minutes=0`, `expire_events=1`, `expire_detail = -120:comp_time_expiry`.
Also re-check the null lot is **untouched**:
```bash
psql "$PGURL" -c "SELECT status FROM attendance_leave_balances WHERE source_key = 'overtime_conversion:$OT_NULL';"  # active
```

### 4.6 Idempotency — a second tick writes no second event

```bash
sleep 12     # another scheduler interval
psql "$PGURL" -c "SELECT count(*) AS expire_events FROM attendance_leave_balance_events e
  JOIN attendance_leave_balances b ON b.id = e.balance_id
  WHERE b.source_key = 'overtime_conversion:$OT_REQ' AND e.event_type = 'expire';"
```
**PASS:** still `expire_events = 1`.

### 4.7 Cleanup + residue assertion

```bash
psql "$PGURL" <<SQL
DELETE FROM attendance_leave_balance_events
  WHERE balance_id IN (SELECT id FROM attendance_leave_balances
    WHERE source_key IN ('overtime_conversion:$OT_REQ','overtime_conversion:$OT_NULL'));
DELETE FROM attendance_leave_balances
  WHERE source_key IN ('overtime_conversion:$OT_REQ','overtime_conversion:$OT_NULL');
DELETE FROM attendance_requests WHERE id = ANY (ARRAY['$OT_REQ','$OT_NULL']::uuid[]);
SQL
curl -s "${H[@]}" -X PUT "$BASE/api/attendance/settings" \
  -d "$(jq -cn --argjson comp "$ORIG_COMP_TIME" '{compTimeFromOvertime:$comp}')" | jq '.data.compTimeFromOvertime'
curl -s "${H[@]}" -X DELETE "$BASE/api/attendance/overtime-rules/$OT_RULE" | jq '.ok'
psql "$PGURL" -c "SELECT count(*) AS residue FROM attendance_leave_balances
  WHERE source_key IN ('overtime_conversion:$OT_REQ','overtime_conversion:$OT_NULL');"
```
**PASS:** settings are restored, the temporary OT rule delete returns `true`, and `residue = 0`.

---

## 5. Pass criteria (all held on 2026-06-04) → `④ C4 ✅`

1. 4.3 `exact_30d = t` (grant stamps `granted_at + 720h`, DST-free).
2. 4.4 null-expiry lot `expires_at = NULL` (no behaviour change when unset).
3. 4.5 aged lot → `expired` + `remaining=0` + exactly one `-120:comp_time_expiry` event, **driven by the
   deployed background scheduler** (closes the §2 caveat).
4. 4.5 null lot survives the scan.
5. 4.6 second tick → still exactly one event (idempotent).
6. 4.7 `residue = 0` and settings restored.

Tracker rows `加班↔调休` / `假期过期管理` were backfilled to `✅` with `#2274` + the smoke evidence above.

---

## 6. Risks / deferred after C4 closeout

- **R1 — background-scheduler wiring is now staging-proven.** The 2026-06-04 smoke closed the CI caveat by
  proving startup wiring + env-gated periodic tick in a deployed process.
- **R2 — staging migration state.** The 2026-06-04 pre-smoke check confirmed staging is migrated through
  C1–C3 (`kysely_migration` count `177`, C1 tables/columns present). Future staging runs should still repeat
  the same schema probe before treating C4-2 as a pure image bump.
- **R3 — C5 not in scope.** No reminders, no notifier channels (scaffold only), no 未排班提醒. Deferred.
- **R4 — leader lock untested here.** Single staging instance ⇒ `ENABLE_ATTENDANCE_SCHEDULER_LEADER_LOCK`
  left off; the load-shed path is unexercised on staging (correctness does not depend on it by design §2.2).
