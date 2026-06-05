# ⑤ Unscheduled-shift reminder — design-lock (small, pre-impl)

**Status:** design-lock. Implements tracker item ⑤ (未排班提醒). Reuses the C4 `AttendanceScheduler`
base — **no second scheduler**. Default **OFF/inert**. No external channels (that is C5), no punch-time
policy (that is ② `punchPolicy.unscheduled`, already shipped), no owner/admin fan-out (deferred).

Governing: tracker `attendance-dingtalk-benchmark-target-and-tracker-20260601.md` ⑤; the C4 base
(`AttendanceScheduler` / `AttendanceNotifier`, #2274).

---

## 1. The two reuse keystones (do NOT reinvent)

- **`isUserScheduledForDate(db, orgId, userId, date)`** (`plugins/plugin-attendance/index.cjs:11966`) —
  the shared predicate. `!isUserScheduledForDate(...)` ⇒ "unscheduled". It encodes the **applicability
  guard** (a user is eligible to be "unscheduled" only if they are in ≥1 group AND **every** active group
  is `scheduled_shift`; any `fixed_shift`/`free_time`/no-group ⇒ always "scheduled") and the **coverage
  check** (`attendance_schedule_group_members` window OR `attendance_shift_assignments` window) and a
  DB-schema-error fail-safe (⇒ scheduled). The punch path (`index.cjs:18931`) already reuses it.
- **`AttendanceScheduler`** (`packages/core-backend/src/services/AttendanceScheduler.ts`) — the C4 base
  (env-gated, leader-elected, `unref` interval). I add a **second job**, not a second scheduler.

## 2. Placement decision (the key call)

The scan job lives in **core-backend** as `UnscheduledReminderService`, **parallel to
`AttendanceExpiryService`** — a request-context-free batch on attendance tables, owned by the same
time-driven scheduler that owns expiry. It does the scan as a **single set-based SQL that mirrors
`isUserScheduledForDate` exactly** (a prominent cross-ref comment + the §6 parity tests are the
anti-drift lock). Rationale: (a) the scheduler is core-backend and already injects a core-backend job
(`AttendanceExpiryService`) — keeping the boundary that ④ established; (b) a set-based scan is strictly
better than N per-user predicate calls for a batch; (c) literal reuse of the plugin function would force
the core-backend scheduler to depend on the plugin (wrong dependency direction). "Reuse the shared
predicate where possible" ⇒ reuse its **logic/SQL shape**, parity-locked by tests, since the literal
function can't cross the boundary without inverting it.

## 3. Components

1. **`UnscheduledReminderService`** (new, `core-backend/src/services/UnscheduledReminderService.ts`),
   `run(): Promise<UnscheduledReminderResult>`:
   - `target_date = utcToday() + lookaheadDays` (default **1** = tomorrow; injectable clock for tests).
   - **Scan SQL** (mirrors the predicate, set-based, all orgs):
     ```sql
     WITH eligible AS (   -- the applicability guard, as bool_and
       SELECT m.org_id, m.user_id
       FROM attendance_group_members m
       JOIN attendance_groups g ON g.id = m.group_id AND g.org_id = m.org_id
       GROUP BY m.org_id, m.user_id
       HAVING bool_and(g.attendance_type = 'scheduled_shift')   -- every group scheduled_shift
     )
     SELECT e.org_id, e.user_id FROM eligible e
     WHERE NOT EXISTS ( SELECT 1 FROM attendance_schedule_group_members sgm
                         WHERE sgm.org_id=e.org_id AND sgm.user_id=e.user_id AND sgm.schedule_group_id IS NOT NULL
                           AND COALESCE(sgm.effective_from,'0001-01-01') <= $1::date
                           AND COALESCE(sgm.effective_to,'9999-12-31') >= $1::date )
       AND NOT EXISTS ( SELECT 1 FROM attendance_shift_assignments sa
                         WHERE sa.org_id=e.org_id AND sa.user_id=e.user_id AND COALESCE(sa.is_active,true)=true
                           AND sa.start_date <= $1::date
                           AND COALESCE(sa.end_date,'9999-12-31') >= $1::date )
     ```
   - **Claim + record (idempotency guard = the UNIQUE constraint, mirrors ④'s status-claim):**
     `INSERT INTO attendance_unscheduled_reminder_dispatch (org_id,user_id,target_date,reminder_type)
      SELECT org_id,user_id,$1,'unscheduled' FROM (scan) ON CONFLICT DO NOTHING RETURNING org_id,user_id`.
     The **RETURNING set = the newly-claimed reminders** (a repeat tick re-scans, conflicts, returns
     nothing → at-most-once). This dispatch row IS the v1 "delivery": an internal, durable record that
     "user U had no schedule for date D" — safe, no external contact.
   - **Notifier dispatch (conservative):** pass the newly-claimed rows to the injected `AttendanceNotifier`
     (`notify(messages)`). Default = **0 channels** ⇒ no-op, **no external send**. External channels are C5.
   - Returns `{ targetDate, scanned, claimed, dispatched }`.
2. **Dedup/record table** (new migration `zzzz20260604120000_create_attendance_unscheduled_reminder_dispatch.ts`,
   sorts after the current highest `zzzz20260603140000`): columns `id uuid pk, org_id text, user_id text,
   target_date date, reminder_type text default 'unscheduled', dispatched_at timestamptz default now(),
   created_at timestamptz default now()`, **`UNIQUE(org_id,user_id,target_date,reminder_type)`**. This is
   both the dedup ledger and the internal reminder record. (DDL is in scope for ⑤ — the ④ "no DDL" rule
   was ④-specific; ⑤ inherently needs a reminder/dedup store. One small table, no balance-model change.)
3. **`AttendanceScheduler` extension (minimal, ④-safe):** add optional `reminderJob?: { run(): Promise<unknown> }`
   to `AttendanceSchedulerOptions`; change the interval body in `startTickLoop` from `void this.tick()` to
   `void this.runCycle()`, where `runCycle()` = `await this.tick()` (expiry, **signature unchanged** → ④
   tests untouched) then, if `reminderJob && isLeader`, `await this.reminderJob.run()` — **each in its own
   try/catch** so one failing job never affects the other. Add `resolveUnscheduledReminderJob()` that
   returns the job iff `ATTENDANCE_UNSCHEDULED_REMINDER_ENABLED==='true'` (default OFF), else `null`.
4. **`index.ts` wiring:** build `reminderJob` (env-gated) with an `AttendanceNotifier` from
   `createAttendanceNotifierChannelsFromEnv()` (= `[]` today → no external send) and pass to
   `startAttendanceScheduler({ ..., reminderJob })`. If env off ⇒ `reminderJob=null` ⇒ scheduler runs
   expiry-only (④ unchanged).

## 4. Config / env defaults (default OFF or inert)

- `ATTENDANCE_UNSCHEDULED_REMINDER_ENABLED` — default **OFF**. Job never runs unless `true`.
- `ATTENDANCE_UNSCHEDULED_REMINDER_LOOKAHEAD_DAYS` — default **1**, clamped `[1,14]`.
- Notifier channels — none by default (`createAttendanceNotifierChannelsFromEnv` returns `[]`), so even
  when enabled the only effect is the internal dispatch record; **no surprise external send**.
- Requires the shared base `ATTENDANCE_SCHEDULER_ENABLED=true` (no second scheduler) — expiry stays inert
  if no org set `expiresInDays`, so enabling the base for reminders does not silently start expiring.

## 5. Idempotency / correctness

- **At-most-once** per `(org,user,target_date,'unscheduled')` via the UNIQUE constraint + `ON CONFLICT DO
  NOTHING RETURNING` claim — chosen over at-least-once (never double-remind). Mirrors ④'s claim-is-guard.
- **Fixed/free never false-positive** — inherited verbatim from the `bool_and(attendance_type='scheduled_shift')`
  guard (== the predicate's `allScheduledShift`).
- **Concurrency-safe** — the unique-constraint claim makes a duplicate/concurrent tick a no-op without a lock.
- **Re-entrancy guard** — the service carries a `running` flag (mirrors expiry's `running` guard); a slow
  scan never overlaps itself (the claim already makes overlap merely wasteful, not wrong — match the pattern).
- The service splits **`scanCandidates(targetDate)`** (pure read, no side-effects) from **`run()`** (scan →
  claim → dispatch). `scanCandidates` is what the §6 parity test compares against the predicate.

## 6. Tests (real-DB integration; rides the existing CI attendance DB step)

New `packages/core-backend/tests/integration/attendance-unscheduled-reminder.test.ts`, **added to the
`Run attendance integration tests` step file-list in `plugin-tests.yml`** (next to
`attendance-plugin.test.ts` / `attendance-expiry-service.test.ts`) so it runs blocking under the
`DATABASE_URL:?` hard-guard — not skipped. Cases:
- **a)** `scheduled_shift` group member with no assignment for `target_date` → one dispatch row claimed.
- **b)** same member WITH a `shift_assignments` (or `schedule_group_members`) row covering `target_date` → no row.
- **c)** member in a `fixed_shift` (and a `free_time`) group → no row (applicability guard).
- **d)** run twice → still exactly one row, and the injected capture-channel receives the candidate **once**.
- **e)** default notifier (0 channels) → `dispatched=0` (no send) but the internal row IS recorded.
- **f) PARITY (the anti-drift lock — highest value):** `require` the plugin and call the **exported**
  `isUserScheduledForDate` (`index.cjs:15562`) with a thin pool wrapper (`{query:(s,p)=>pool.query(s,p).rows}`).
  Seed N users across group/coverage configs, then assert `scanCandidates(targetDate)` set ==
  `{ seeded users where !isUserScheduledForDate(db,org,u,targetDate) }`. This makes "reuse the shared
  predicate" literal **at the verification layer** — a future change to the predicate that my SQL doesn't
  track fails this test. (Sentinel `'9999-12-31'` == `ATTENDANCE_SCHEDULE_OPEN_END_DATE`; raw==normalized by
  the column CHECK constraint — both verified, both parity-covered.)
- Unit (`attendance-unscheduled-reminder.test.ts` in tests/unit): lookahead/target-date math + clamp; the
  scheduler `runCycle` runs both jobs and isolates a failing reminder from expiry.

**CI proof:** add the new integration file to the `Run attendance integration tests` step in
`plugin-tests.yml` (same DB hard-guard step as expiry), mirror the exact `ATTENDANCE_TEST_DATABASE_URL ||
DATABASE_URL` + `describe` vs `describe.skip` gate, and after CI **grep the job log for the execution line**
(`✓ …unscheduled-reminder.test.ts (N tests) …ms`) — report that, not merely "CI green".

## 7. Out of scope / deferred (explicit)

- **What v1 actually delivers (no overselling):** scan → internal dispatch **record** + notifier **seam**.
  With 0 channels (the default) there is **no external delivery and no consumer reads the table yet** — it's
  a deliberately inert, staged-opt-in engine ("DB event, 避免误发"). A real channel behind an explicit env
  is a trivial C5 follow-up; this PR does not add one.
- **Recipient — deliberate deferral:** the goal named "提醒负责人/本人". v1 records the **unscheduled user
  (本人)** as the recipient; **负责人/owner fan-out is deferred** (the dispatch row carries `user_id`; an
  owner-routing layer is additive later). Flagged here, not buried.
- Per-org enable + per-org lookahead (v1 is env-global) = deferred. Org-timezone-aware `target_date`
  (v1 = UTC date + lookahead) = deferred residual risk.
- **Staging debt:** the new migration **adds to the staging-migration-align debt** that is already part of
  why ④'s staging smoke is blocked — ⑤'s own staging smoke inherits the same gate.
- S2 in/out merge, S3 outdoor, auto-match, payroll, anti-cheat, native, AI = **not touched**.

## 8. Graduation

Code-green (CI: the integration test runs in the DB step + passes) lands ⑤ as **code-complete**. The
tracker ⑤ row goes to a **progress note, NOT ✅** — a staging smoke (deploy with the env on + a capture/log
channel, observe a dispatch record for a seeded unscheduled member, re-tick no-dup) is required for ✅,
same gate as ④, and is deferred to tunnel-up. **Do not mark ⑤ ✅ without staging evidence.**
