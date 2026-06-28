# Date-reminder `timeOfDay`-aligned scheduling — dev & verification (2026-06-28)

> Follow-up to #3329 (`schedule.date_field`, on `main`). Closes the owner-found **P2**: `timeOfDay` gated only the due-predicate, it did not drive *when* the scan ran. Design-lock: `docs/design/multitable-date-reminder-timeofday-alignment-design-lock-20260628.md` (owner-ratified: option 1, grace = 48h, decouple `scanIntervalMs`). Branch `claude/multitable-date-reminder-designlock-20260628`, grounded `origin/main` @ `bb350be40`.

## 1. The defect
`schedule.date_field` registered a **boot-anchored `setInterval(scanIntervalMs)`** (default 24h) with no first-tick alignment — a rule for 09:00 fired whenever the daily tick happened to land relative to server boot (boot 03:00 ⇒ ~18h late), while the UI + core comment promised a precise time, and the scheduler cadence was **untested** (real-DB tests drove only `runDateReminderScanNow`). Latent: `scanIntervalMs` was load-bearing twice — the timer cadence **and** `scanWindow = 2×scanIntervalMs` — so a script value silently distorted the dedup/backfill window.

## 2. Implementation (DR-A…E)
- **DR-A — `timeOfDay`-aligned scheduling** (`automation-scheduler.ts`): the `schedule.date_field` branch no longer uses `setInterval`. New pure helper `nextDateReminderTimerDelayMs(timeOfDay, now)` computes the next UTC `timeOfDay` boundary; `armDateFieldTimer` arms a `setTimeout` to it and **re-arms for the next day** on fire (guarded by `this.timers.get(id) === timer` so an unregister/replace stops the re-arm). No boot anchor. Leader-only + `.unref()` preserved; the callback runner is extracted to `runScheduledCallback` (shared by cron/interval, unchanged).
- **DR-B — bounded catch-up** : new pure `dateReminderTimeOfDayPassed(timeOfDay, now)`; at register/restart, if today's `timeOfDay` already passed, run **one** immediate scan. It goes through the same `isDateReminderDue` predicate, so `occ ≥ ruleCreatedAt` + the recent window still bound it → **never** a backfill-blast.
- **DR-C — claim/fire ledger unchanged**: `meta_automation_date_reminder_fires` PK `(rule_id, record_id, occurrence_ts)` + `INSERT … ON CONFLICT DO NOTHING RETURNING`. DR-A/DR-B change only *when the scan runs*, never the dedup key — a catch-up + an aligned tick on the same day share the occurrence ⇒ cannot double-fire.
- **DR-D — `scanIntervalMs` decoupled** (`automation-date-reminder.ts` + service): the window is now a **fixed `DATE_REMINDER_GRACE_WINDOW_MS = 48h` constant** (consumed by `isDateReminderDue` + `dateReminderCandidateDateRange`); `dateReminderScanWindowMs` + `dateReminderScanIntervalMs` are **removed**. Per the owner's "约束成内部", `scanIntervalMs` is **retained in the config type but `@deprecated`/ignored** (drives neither scheduling nor the window) — so older persisted rules don't break and it can no longer masquerade as the trigger time.
- **DR-E — text matches behavior**: the `setInterval` fix makes the UI label "触发时间（UTC）" *true*; added a hint ("每天按此 UTC 时间触发；服务重启后会补发当天到点的提醒。" / "Fires daily at this UTC time; a restart catches up today's due reminders.") and corrected the core comment that referenced the removed window helper.

## 3. Verification
- **Fake-timer GOLDEN — 5/5** (`automation-scheduler-date-reminder.test.ts`, NEW — closes the untested-cadence gap): **G1/G2** boot 03:00 + rule 09:00 → not fired at register, fires once **at** 09:00 (the boot-anchor regression: G1 fails on the old `setInterval`); **G3** restart 10:00 → one bounded catch-up; **G4** re-arms for the next day (no same-day double, fires again at next 09:00); **G5** unregister cancels the pending timer; + non-leader never arms.
- **Pure-core unit — 17/17** (`automation-date-reminder.test.ts`): added `nextDateReminderTimerDelayMs` (today-vs-tomorrow boundary), `dateReminderTimeOfDayPassed` (boundary-inclusive), and the fixed-48h `DATE_REMINDER_GRACE_WINDOW_MS`; occurrence purity + firing-window bounds unchanged.
- **Scheduler regression — 32/32** (`automation-scheduler-leader` + `-metrics` + the two date-reminder suites): the `register()` restructure + `runScheduledCallback` extraction leave cron/interval/leader behavior green.
- **Real-DB integration — 11/11** (`multitable-date-reminder-trigger.test.ts`): DR-1 fire-once / DR-2 idempotent / DR-3 backfill-bound / DR-6 date-edit / DR-VAL ×4 + valid-save / DR-DISABLED — all green, proving the 48h-constant window (= the old 2×24h value) didn't move scan/claim/fire. (Test DB brought current via the migrate runner; #3329's `add_date_field_trigger_type` + `create_date_reminder_fires` applied.)
- **Typecheck**: backend `tsc --noEmit` exit 0; frontend `vue-tsc -b` exit 0; editor spec 95/95.

## 4. The owner's 5 golden cases — where each is locked
1. boot 03:00 + rule 09:00 → no 03:00 fire — **golden G1**. 2. fires 09:00 — **golden G2**. 3. restart 10:00 catch-up once — **golden G3**. 4. second tick/restart no duplicate — **golden G4** (re-arm → next day, no same-day double) at the scheduler axis; cross-restart dedup at the service axis = real-DB **DR-2** (claim ledger). 5. fresh rule after 09:00 no backfill — firing-window predicate = pure unit + real-DB **DR-3**.

## 5. Invariants — CONFIRMED
- `timeOfDay` drives the actual fire time (UTC), bounded catch-up on restart, never a backfill-blast. ✓
- The dedup/backfill window is a fixed 48h constant — a per-rule/script `scanIntervalMs` can no longer distort it. ✓
- Claim ledger + at-most-once unchanged; cron/interval scheduling unchanged. ✓
- Scope unchanged from #3329: UTC-only bucketing, whole-day offsets, ledger retention deferred. ✓

## 6. Boundary / deferred (named)
- **Boot-scan burst (behavior delta vs the old `setInterval`):** DR-B runs one `evaluateDateReminders` per `date_field` rule on register, so a leader boot/failover *after* `timeOfDay` with N such rules kicks off ~N near-simultaneous catch-up scans (the old boot-anchored `setInterval` deferred the first scan instead). Each scan is bounded + idempotent, so it's correct; at scale a future slice could stagger/coalesce the catch-up. Non-blocking at current rule counts.
- Unchanged deferred from #3329: tz-aware day boundaries, sub-day offsets, `date_reminder_fires` retention/aging.
