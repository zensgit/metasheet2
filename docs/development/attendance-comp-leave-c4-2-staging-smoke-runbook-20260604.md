# ④ C4-2 staging smoke runbook + CI evidence (comp-time expiry scheduler)

**Status:** C4-2 code is **merged** (#2274, merge commit `4b3108737`, on `origin/main`); CI is
**fresh-green** and the attendance DB step genuinely ran the C4 spec (evidence §2). The **`④ C4 ✅`
graduation is still gated on the staging C4 smoke below** — per the #2267 design-lock and #2230 governing
("`④ C4 ✅` is gated on C4-2 + a staging C4 smoke"). This doc is that smoke, **prepared but not yet run**:
it could not be executed from the dev sandbox (§3). It stays in `⬜` on the tracker until the smoke PASSES.

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

## 3. Why this smoke was NOT run from the dev sandbox (the blocker — report, don't force)

Three independent blockers, any one of which stops a sandbox-driven run:

1. **Staging `:8082`/`:22` are not usable from the sandbox in the current route state.** Probed two ways:
   a plain `curl http://142.171.239.56:8082/health` times out at HTTP `000`; and although `nc -z` to both
   `:22` and `:8082` *succeeds* (TCP SYN-ACK), the application handshakes do **not** complete —
   `curl :8082` still returns HTTP `000` and `ssh -i ~/.ssh/metasheet2_deploy mainuser@…` is
   `Connection closed by …:22` before auth. "TCP-open but HTTP/SSH die at handshake" = the local route is
   not going through the working **v2ray** path. The fix is `use-v2ray-142-ssh.command` (it
   `sudo route delete`s the static host route so traffic uses v2ray, then SSH-tests) — that needs **sudo +
   the operator's v2ray**, so the tunnel cannot be brought up from an unattended sandbox. (`github.com`
   returns HTTP `200` from the same shell, so general outbound is fine — this is host-route-specific.)
2. **Staging is not yet running C4-2.** Staging does not auto-mirror `main`; the last staging deploy was
   `0fd25d3ed` (③ shift-compliance, 2026-06-03) — **before** C4-2 (`4b3108737`) merged on 2026-06-04. So a
   deploy/image-bump is required first, and that is an owner-authorized live-infra action, not a sandbox one.
3. **The smoke is not pure-HTTP** (unlike ③). `expiresInDays` minimum is **1 day** (fixed 24 h) and the
   scheduler default tick is hourly — you cannot "grant then wait it out" inside a smoke window. The lot's
   `expires_at` must be **aged in SQL** and the **deployed background scheduler** must be running on a short
   interval. So the run needs **both** an HTTP path (grant) **and** psql on the staging DB (age + assert the
   `expire` event) — i.e. an SSH session into staging, which is the owner's to drive.

Per the goal's guardrail ("如果 staging/migration/CI blocker 出现，停止并报告，不要扩大范围"): this is reported,
not forced. The procedure below is ready to copy-paste once staging is deployed.

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
```

### 4.1 Enable expiry + create an OT rule

```bash
curl -s "${H[@]}" -X PUT "$BASE/api/attendance/settings" \
  -d '{"compTimeFromOvertime":{"enabled":true,"expiresInDays":30}}' | jq .
# capture the original compTimeFromOvertime first if you want a clean restore:
#   curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/attendance/settings" | jq '.data.compTimeFromOvertime'

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
# restore the original compTimeFromOvertime setting (use the value captured in 4.1), then:
psql "$PGURL" -c "SELECT count(*) AS residue FROM attendance_leave_balances
  WHERE source_key IN ('overtime_conversion:$OT_REQ','overtime_conversion:$OT_NULL');"
```
**PASS:** `residue = 0`. Delete the `$SUF-ot` overtime rule too if your staging org should stay pristine.

---

## 5. Pass criteria (all must hold) → only then flip `④ C4 ✅`

1. 4.3 `exact_30d = t` (grant stamps `granted_at + 720h`, DST-free).
2. 4.4 null-expiry lot `expires_at = NULL` (no behaviour change when unset).
3. 4.5 aged lot → `expired` + `remaining=0` + exactly one `-120:comp_time_expiry` event, **driven by the
   deployed background scheduler** (closes the §2 caveat).
4. 4.5 null lot survives the scan.
5. 4.6 second tick → still exactly one event (idempotent).
6. 4.7 `residue = 0` and settings restored.

On all-PASS: backfill the tracker rows `加班↔调休` / `假期过期管理` to `✅` with `#2274` + this smoke's
evidence, and add a `回填（C4 closeout）` line. **Until then they stay `⬜`.**

---

## 6. Risks / deferred (carried into the report)

- **R1 — background-scheduler wiring is only proven by this staging smoke.** CI proves the expiry SQL +
  grant; it does not start the env-gated timer. If the smoke is skipped, the startup wiring
  (`src/index.ts` → `startAttendanceScheduler` → `ATTENDANCE_SCHEDULER_ENABLED`) is unverified in a
  deployed process. (Mitigated only by running §4.)
- **R2 — staging migration state.** Assumes staging is migrated through C1–C3. If not, §4.0's pure-image-bump
  assumption is false and the #2226 align + C1 DDL must land first (heavier blocker → STOP + report).
- **R3 — C5 not in scope.** No reminders, no notifier channels (scaffold only), no 未排班提醒. Deferred.
- **R4 — leader lock untested here.** Single staging instance ⇒ `ENABLE_ATTENDANCE_SCHEDULER_LEADER_LOCK`
  left off; the load-shed path is unexercised on staging (correctness does not depend on it by design §2.2).
