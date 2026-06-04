# ④ C4 execution design-lock — comp-time expiry state-flow + AttendanceScheduler base

**Status:** design-lock (docs-only). Impl slices C4-1 / C4-2 are **gated** and NOT started.
**Governing doc:** `attendance-comp-leave-expiry-design-lock-20260603.md` (#2230) — the ④ model
(grant-LOT ledger, events audit, FIFO deduction, scheduler/notifier boundary) is locked there and is
**NOT re-derived here**. This doc pins only the C4 **deltas**: the two ambiguity-killers the owner asked
for (`expires_at` 口径 + concurrency-safe expiry), the `expiresInDays` config, the `remaining_minutes`
disposition, and the slice/acceptance plan. Where this doc and #2230 appear to differ, #2230 governs the
model and this doc governs the C4 execution detail.

Prior chain on `main`: **C0** staging-align · **C1** ledger DDL (#2231) · **C2** OT→comp-time credit
(#2252) · **C3** comp_time-leave deduction (#2261, staging-validated). C4 adds the **expiry state-flow +
the scheduler base** that drives it. Reminders/notifications are **C5**, not C4.

---

## 1. Scope (locked)

- **C4 = `AttendanceScheduler` base + the comp-time expiry state-flow.** Nothing else.
- **NO reminders, NO messages in C4.** The scan flips status + writes an audit event; that is the whole
  job. Pre-expiry reminders, the reminder job, and notification channels are **C5**.
- **C4 builds the scheduler base once** (⑤ 未排班提醒 reuses it — never a second scheduler), env-gated,
  leader-elected, mirroring `ApprovalSlaScheduler` per #2230 §base.

---

## 2. The two pinned details (owner-requested)

### 2.1 `expires_at` 口径 — PIN: grant-instant + a **fixed** N×24h duration (timezone-free)

The owner flagged "org-local end-of-day vs approval-time + days — 别留时区歧义." Decision:

- **`expires_at = granted_at + N * interval '24 hours'`** where N = the configured validity in days. This
  is a **fixed duration** (24h is always 86 400 s) and is therefore **DST- and timezone-independent**, and
  it is compared against `now()` (both `timestamptz`). This is the literal "no timezone ambiguity" answer.
- **Do NOT use `interval 'N days'`.** Postgres resolves the *days* field of an interval in the session
  `TimeZone`, so across a DST boundary a "day" is 23 or 25 hours — that silently reintroduces the very
  ambiguity we are killing. Equivalent safe forms: `granted_at + make_interval(hours => N*24)`.
- **Rejected: org-local end-of-day.** It is more "calendar-intuitive" but *introduces* a timezone
  dependence (needs a resolved org tz at grant time) — the opposite of the owner's ask. If the product
  later wants end-of-day semantics, that is an explicit follow-up that first pins the org-tz source.
- Consistent with #2230 §grant (`expires_at = granted_at + 调休有效期`).

### 2.2 Concurrency-safe expiry — PIN: claim-by-status, event only for transitioned rows

Owner pin: *"即使 leader lock 失效，也要靠 `UPDATE ... WHERE status='active' ... RETURNING` 或同等事务方式避免双 event."*

- The **`status='active'` predicate in the mutating statement IS the idempotency guard** — not the leader
  lock. Under READ COMMITTED, a concurrent or duplicate tick (even with the leader lock failed/expired)
  re-checks each row after the first tick commits (EvalPlanQual); the row is now `status='expired'`, no
  longer matches the predicate, so it updates **0 rows → writes 0 events**. **The `expire` event is written
  only for the rows this statement actually transitioned.** A second scan over the same data is a no-op.
- **No advisory lock is needed for correctness.** Leader-election (§5) is purely a **load optimisation**
  (don't have every instance scan); C4-2 must NOT grow a redundant `pg_advisory_lock` around this — the
  claim is already the full guarantee.
- **Scan predicate (locked, exact):**
  `status = 'active' AND remaining_minutes > 0 AND expires_at IS NOT NULL AND expires_at <= now()`.
  The `expires_at IS NOT NULL` clause is load-bearing: **NULL-expiry lots never auto-expire** (the owner's
  "既有 expires_at=NULL 的 lot 不回填、不自动过期" promise).

### Canonical statement (impl finalises in C4-1; shape locked here)

```sql
WITH candidates AS (
  SELECT id, org_id, user_id, remaining_minutes
  FROM attendance_leave_balances
  WHERE status = 'active' AND remaining_minutes > 0
    AND expires_at IS NOT NULL AND expires_at <= now()
  FOR UPDATE SKIP LOCKED            -- non-blocking between concurrent ticks; correctness holds without it
),
expired AS (
  UPDATE attendance_leave_balances b
     SET status = 'expired', remaining_minutes = 0, updated_at = now()
    FROM candidates c
   WHERE b.id = c.id
     AND b.status = 'active'              -- predicate RE-ASSERTED in the mutating statement: this row,
     AND b.remaining_minutes > 0          -- not the SELECT, is the idempotency guard. A concurrent tick
     AND b.expires_at IS NOT NULL         -- that already flipped it fails this WHERE → 0 rows here →
     AND b.expires_at <= now()            -- 0 events below.
   RETURNING b.org_id, b.user_id, b.id, c.remaining_minutes AS expired_minutes
)
INSERT INTO attendance_leave_balance_events
  (org_id, user_id, balance_id, event_type, delta_minutes, source_type)
SELECT org_id, user_id, id, 'expire', -expired_minutes, 'comp_time_expiry'
FROM expired;                            -- events come from the UPDATE's RETURNING, NOT the candidate
                                         -- SELECT — so an event exists iff this statement transitioned
                                         -- that row.
```

**The event set is bound to the UPDATE's `RETURNING`, not to the candidate `SELECT`** — this is what makes
"event only for transitioned rows" literal rather than aspirational. The predicate is **re-asserted inside
the `UPDATE … WHERE`** so the mutating statement (not the earlier `SELECT`) is the guard; a duplicate /
leader-lock-failed tick that lost the race updates 0 rows and therefore writes 0 events. The `candidates`
CTE carries the **pre-zero `remaining_minutes`** forward (as `expired_minutes`) purely so the event delta
(§4) reflects the amount that was forfeited; `SKIP LOCKED` only keeps two ticks from blocking each other.

---

## 3. Config — `compTimeFromOvertime.expiresInDays` (default `null`)

> **Lands in C4-2, with the scheduler — not C4-1.** The config + grant wiring are what cause `expires_at`
> to be written; shipping them *before* a live expirer (the scheduler) would let `expires_at` lots
> accumulate, then bulk-expire the instant C4-2's scheduler turns on. So the expires_at-**writer** (this
> §) and the expires_at-**consumer** (the scheduler, §5) ship in the **same slice** (C4-2). C4-1 adds only
> the uncalled expiry function (§7) and writes no `expires_at` → genuinely inert.

- New org-settings field **`compTimeFromOvertime.expiresInDays`**, alongside the existing `enabled`
  (C2). **Default `null` = no expiry = no behaviour change** (every existing and new lot stays immortal).
- When `expiresInDays` is a positive integer **and** `enabled` is true, the **C2 grant** (the credit hook
  in `resolveRequest`, plugin `index.cjs`) sets `expires_at = granted_at + expiresInDays * interval '24 hours'`
  (computed in SQL via `now()`, not a client clock). When `expiresInDays` is null, the grant keeps
  `expires_at = NULL` exactly as today.
- **NO backfill.** Turning `expiresInDays` on affects only **new** grants from that point. Existing
  `expires_at = NULL` lots are never rewritten and never auto-expire. (A future explicit "apply expiry to
  existing lots" action, if ever wanted, is out of C4 scope.)
- Settings plumbing mirrors C2's `enabled`: DEFAULT_SETTINGS + `normalizeCompTimeFromOvertimeSetting`
  (validate positive int else null) + per-key `mergeSettings` + PUT `settingsSchema`.

---

## 4. `remaining_minutes` on expiry — PIN: zero, consistent with C3

- On expiry, **set `remaining_minutes = 0`** (status `'expired'`), mirroring C3's `exhausted` → 0. This
  keeps `remaining_minutes` honest as the "快读快照" for **every** status (an expired lot reads 0 usable),
  avoiding a snapshot that lies (status `expired` but remaining 120).
- The **`expire` event records the forfeited amount**: `delta_minutes = -(pre-zero remaining)`, captured by
  the CTE above. This honours #2230's "不静默清零——记录过期事件/可追溯": the forfeit is audited, never
  silently dropped. Per-lot net over events (grant `+amount` … deduct/expire `−…`) reconciles to 0.
- Balance reads remain `… WHERE status='active'` (unchanged from C2/C3); expired lots drop out by status,
  and now also by `remaining_minutes = 0`.

---

## 5. `AttendanceScheduler` base (locked per #2230 §base)

- **Location:** `packages/core-backend/src/services/` (mirrors `ApprovalSlaScheduler`), **not** the plugin.
  The expiry job is pure SQL on the (core-backend-migrated) ledger tables — it needs no request context, so
  it belongs with the other core-backend scheduled services. The plugin keeps the **request-driven**
  mutations (C2 grant / C3 deduct); core-backend owns the **time-driven** batch. Both write the same ledger.
- **Mirror `ApprovalSlaScheduler` exactly:** single-process `setInterval` tick with a one-run (`running`)
  guard; `unref()` timers; env-disable switch; default interval generous (e.g. hourly — expiry is not
  latency-sensitive; impl picks, ≥ a few minutes floor).
- **Leader election = opt-in, load-only.** Reuse `RedisLeaderLock`, env-gated
  **`ENABLE_ATTENDANCE_SCHEDULER_LEADER_LOCK`** (mirror `ENABLE_APPROVAL_SLA_LEADER_LOCK`); no Redis / flag
  off ⇒ `isLeader = true` single-process assumption, same as `ApprovalSlaScheduler`. Because §2.2's claim is
  self-guarding, a fleet running without the lock is still **correct** (no double events) — just does
  redundant scans.
- **Wiring:** registered at backend startup (`src/index.ts`) next to `startApprovalSlaScheduler`, behind its
  own disable env. v1 wires **only the expiry job**.

---

## 6. Notifier — scaffold only in C4, **no messages**

- C4 may stand up a minimal `AttendanceNotifier` scaffold (the hook seam), but it **sends nothing**. No
  channels are registered, no per-tick warn noise (channel-env-gating discipline). The reminder job +
  env-gated channels + actual dispatch are **C5** (#2230 §C5).
- Acceptance for C4 deliberately excludes any "a message was sent" assertion.

---

## 7. Slices (gated; each a separate opt-in)

Ordered **testable-domain-core first, and expirer-before-writer** (the expires_at *consumer* must not
ship after its *producer* — see §3 / P3). The expiry SQL is the directly-testable core; the scheduler +
the config/grant that start writing `expires_at` ride together on top:

- **C4-1 — the expiry function only (genuinely inert).**
  - The §2.2 atomic claim as a core-backend function/service (`AttendanceExpiryService` or similar),
    callable directly. **No config field, no grant change, no scheduler, no caller.**
  - Because nothing writes `expires_at` yet (C2 grants still all `NULL` until C4-2) and nothing calls the
    function, merging C4-1 changes **zero** runtime behaviour — truly inert, not "stamps data nobody
    consumes."
  - **Real-DB tests, called directly (no scheduler, no grant path):** seed lots with explicit
    `expires_at` (past / future / NULL) via SQL exactly as the C3 test seeds lots, then invoke the
    function and assert §8.1–8.2 + 8.3–8.5. Proves the full state-flow + idempotency in isolation.
- **C4-2 — turn expiry on, atomically: scheduler + config + grant wiring + notifier scaffold.**
  - `compTimeFromOvertime.expiresInDays` settings plumbing + the C2 grant hook writing `expires_at` (§3).
  - `AttendanceScheduler` (§5): leader-election, `unref`/disable envs, startup wiring, ticking the C4-1
    function; minimal `AttendanceNotifier` scaffold (§6, no messages).
  - Shipping the writer (grant) and the consumer (scheduler) in one slice means there is **no window**
    where `expires_at` lots pile up without an expirer.
  - Tests: grant sets `expires_at` iff configured (§8.6–8.8, in `attendance-plugin.test.ts`); scheduler
    tick → expiry runs, non-leader / disabled → no-op.

**"④ C4 ✅" is gated on C4-2 + a staging C4 smoke** (deploy → enable `expiresInDays` → grant a short-lived
lot → let the scheduler expire it → assert status/remaining/event + re-scan idempotent), same graduation
rule as C2/C3. C4-1 merging does not flip ④ C4 and changes no behaviour.

---

## 8. Acceptance / test matrix (the easy-to-forget guarantees are explicit)

Real-DB integration (direct function call for C4-1; scheduler tick for C4-2):

1. **Expire happy-path:** an `active`, `remaining>0`, past-`expires_at` lot → `status='expired'`,
   `remaining_minutes=0`, **one** `expire` event with `delta = -(pre-zero remaining)`.
2. **招牌 idempotency:** run the scan **twice** → **exactly one** `expire` event, second run changes nothing.
3. **NULL-expiry survives:** an `expires_at IS NULL` lot is **never** touched by a scan (the
   "既有 NULL lot 不自动过期" promise — the `expires_at IS NOT NULL` predicate).
4. **Future-expiry survives:** an `expires_at > now()` lot is untouched.
5. **Already-spent untouched:** a `status='exhausted'`/`remaining=0` lot is not re-expired (predicate).
6. **Grant side — expires_at iff configured:** with `expiresInDays=N` set, a C2 grant writes
   `expires_at ≈ granted_at + N×24h`; with `expiresInDays=null`, the grant writes `expires_at=NULL`.
7. **No backfill:** toggling `expiresInDays` on does not rewrite existing `expires_at=NULL` lots.
8. **Default-off = no behaviour change:** with `expiresInDays` unset, nothing in C2/C3 changes.

---

## 9. Housekeeping (fold into the C4 PR that touches the test file)

- **`::text[]` → `::uuid[]` cleanup fix.** The C2+C3 `finally` blocks in
  `packages/core-backend/tests/integration/attendance-plugin.test.ts` do
  `DELETE FROM attendance_requests WHERE id = ANY($1::text[])`, but `attendance_requests.id` is `uuid`; the
  cast throws `uuid = text` and the `.catch` swallows it → orphan request rows leak (harmless on CI's
  fresh DB, leaks locally). Fix to `::uuid[]` (or delete by the text `user_id`). **Fold into C4-2** — that
  is the slice that touches `attendance-plugin.test.ts` (the grant-sets-`expires_at` test, §8.6–8.8). C4-1's
  tests live in a *core-backend* service test file, so the fold-in will **not** ride along with C4-1; land
  it as a **deliberate hunk** in C4-2.
