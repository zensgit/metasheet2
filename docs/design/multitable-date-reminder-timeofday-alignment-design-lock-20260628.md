# Date-reminder `timeOfDay`-aligned scheduling — Design Lock

> Status: **RATIFIED (owner-specified) + BUILT + VERIFIED.** Owner ratified option 1 with the full 5-point spec (grace = 48h, decouple `scanIntervalMs`); built on this branch — see `docs/development/multitable-date-reminder-timeofday-alignment-dev-verification-20260628.md`. Follow-up to #3329 (`e64414297`, `schedule.date_field` on `main`). Grounding: `origin/main` @ `bb350be40`. Closes the owner-found P2: `timeOfDay` did not drive *when* the scan runs — it was only a threshold inside the due-predicate.

## 1. The defect (owner-found, P2)
`schedule.date_field` registers a boot-anchored `setInterval(scanIntervalMs)` (default 24h) — `automation-scheduler.ts:289`; the timer fires the cron callback with **no first-tick alignment and no immediate catch-up** (`:305`). So a rule configured for `09:00` fires whenever the daily tick happens to land relative to **server boot time** — e.g. boot at UTC 03:00 ⇒ first fire ~next day 03:00, ≈18h late. Meanwhile the UI ("触发时间（UTC）", `MetaAutomationRuleEditor.vue:99`) and the core comment ("when on reminder day to fire", `automation-date-reminder.ts:33`) both promise a precise fire time. The real-DB tests only drive `runDateReminderScanNow`, so the scheduler cadence is **untested**. → behavior contradicts the promise, and it's unverified.

Plus the latent coupling: `scanIntervalMs` is load-bearing in **two** unrelated roles — the timer cadence **and** the dedup/backfill window (`dateReminderScanWindowMs(scanIntervalMs) = scanIntervalMs × 2`, consumed by `isDateReminderDue` + `dateReminderCandidateDateRange`). A hidden/script-set `scanIntervalMs` therefore distorts the **window semantic** without changing real scan rhythm.

## 2. Decision — option 1 (timeOfDay-aligned), not text-downgrade
The fire time must be honored. Keep the daily cadence (no hourly-scan DB-load blow-up); align the timer to `timeOfDay` instead of boot time, and **split the two `scanIntervalMs` roles**.

## 3. Locked design (the items to ratify)

**DR-A — timeOfDay-aligned scheduling (replace boot-anchored `setInterval`).**
For `schedule.date_field`, the scheduler computes the **next UTC `timeOfDay` boundary** and arms a `setTimeout` to it; on fire it runs `evaluateDateReminders` then **re-arms for the next day's `timeOfDay`**. No `setInterval`; no boot-time anchor. (Leader-only and `.unref()` unchanged.)

**DR-B — bounded catch-up on register/restart.**
If, at register/restart, today's `timeOfDay` has **already passed**, run **one** immediate catch-up scan before arming the next-day timer — so a deploy at 10:00 still delivers the 09:00 reminders for today. The catch-up goes through the **same** `isDateReminderDue` predicate, so it stays bounded by `occ ≥ ruleCreatedAt` **and** the recent window — it can **never** backfill-blast. (A restart that misses a full day beyond the grace window skips — the documented at-most-once tradeoff, unchanged.)

**DR-C — claim/fire ledger unchanged.**
`meta_automation_date_reminder_fires` PK `(rule_id, record_id, occurrence_ts)` + `INSERT … ON CONFLICT DO NOTHING RETURNING` stays exactly as shipped. At-most-once by construction. DR-A/DR-B only change *when the scan runs*, never the dedup key — so a catch-up scan + the aligned tick on the same day cannot double-fire (same occurrence ⇒ same claim row).

**DR-D — split `scanIntervalMs`'s two roles (the owner's core point). [sub-decision to ratify]**
The dedup/backfill **window** must stop riding on a cadence knob. Recommendation:
- The recent window becomes a **fixed named constant** `DATE_REMINDER_GRACE_WINDOW_MS = 48h` (2× daily grace), independent of any per-rule config. `isDateReminderDue` + `dateReminderCandidateDateRange` take this constant; `dateReminderScanWindowMs(scanIntervalMs)` is **removed**.
- `scanIntervalMs` is **removed from `ScheduleDateFieldConfig`** (it was never a UI field — a hidden override only). The save-validator rejects/ignores it so it can't be persisted to re-distort anything. Real rhythm = DR-A's daily `timeOfDay` alignment; if a faster internal catch-up is ever needed it's an internal constant, not a per-rule window-affecting knob.
- *Alternative if you'd rather not change the schema:* keep `scanIntervalMs` in the type but make it **purely an internal catch-up cadence** that does NOT feed the window (window = the 48h constant regardless). I recommend the removal — it's the honest shape. **← please pick.**

**DR-E — text matches behavior.**
UI label, the core comment (`automation-date-reminder.ts:33`), and the #3329 dev MD updated: `timeOfDay` genuinely drives the fire time (UTC, v1), with a clearly stated bounded catch-up on deploy — no "scan-delay" weasel and no false "precise to the second" either.

## 4. Fail-first golden (scheduler fake-timers — the untested gap)
Locks DR-A/DR-B/DR-C with `vi.useFakeTimers()` (no real DB needed for the timing axis; reuse the deterministic seam for fire-counting):
1. **boot 03:00 + rule 09:00 → NOT fired at 03:00** (boot-anchor regression caught).
2. advance to **09:00 → fires once**.
3. **restart at 10:00 → one catch-up fire** for today (DR-B), not zero, not a blast.
4. **second tick / second restart same day → no duplicate** (DR-C claim).
5. **fresh rule created at 09:30 → does NOT backfill** today's 09:00 occurrence (`occ < ruleCreatedAt`).

Plus: the existing 16 pure unit + 11 real-DB tests stay green; add/extend a real-DB case asserting the aligned path (not just `runDateReminderScanNow`) fires once.

## 5. Scope / non-goals (unchanged from #3329)
UTC-only day bucketing (tz-aware boundary deferred); whole-day offsets only; ledger retention/aging deferred; at-most-once delivery. This lock touches **only** *when the scan runs* + the `scanIntervalMs`/window decoupling — not the occurrence math, the dedup ledger, or the UTC semantic.

## 6. Build sequence (post-ratify only)
design-lock ratified → DR-A/DR-B scheduler rewrite + DR-D core decouple + DR-E text → DR-4 fake-timer golden + real-DB aligned-path case → backend `tsc` + frontend `vue-tsc` + editor specs → dev/verification MD → PR (held for review, not auto-merged).

## 7. Resolved decisions (owner-ratified)
- **DR-D shape** → per the owner's "改名/约束成内部 catch-up 参数": `scanIntervalMs` is RETAINED in the config type but marked `@deprecated`/ignored (drives neither scheduling nor the window), so older persisted rules don't break and it can no longer masquerade as the trigger time. The window is the fixed `DATE_REMINDER_GRACE_WINDOW_MS` constant; `dateReminderScanWindowMs`/`dateReminderScanIntervalMs` removed.
- **Grace window value** → **48h** (2× daily grace), ratified.

## 8. P1 addendum (owner review round 2) — conversion-backfill floor `effectiveAt`
The owner's review of the built PR found a sharper backfill edge: DR-B catch-up + a floor of `rule.createdAt` means a months-old automation **converted** into `schedule.date_field` immediately backfills the last 48h (the row predates its life as a reminder). **Resolved:** a SERVER-SET `effectiveAt` on the date_field config = activation instant; floor = `max(createdAt, effectiveAt)`. Set on create-as-date_field and on transition INTO date_field; preserved on stay/config-edit; never reset by action-only edits; never client-trusted (overwritten on activation); absent ⇒ falls back to `createdAt` (pre-fix rules). Proven by real-DB **DR-7** + 4 pure floor cases. Detail in the dev/verification MD §0.
