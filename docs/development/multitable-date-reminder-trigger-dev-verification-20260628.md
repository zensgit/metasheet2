# Date-reminder automation trigger (`schedule.date_field`) — dev & verification (2026-06-28)

> Status: built + verified (real-DB, with two fail-first proofs). Grounding: `origin/main` @ `43ef71ed9`.
> The lightweight Feishu-parity arc recommended by the post-cross-base frontier note
> (`docs/research/multitable-post-crossbase-frontier-decision-20260628.md`) and authorized by the owner
> ("按建议执行" = GO on the #1 recommendation). Advisor-reviewed before implementation.

## 1. The gap

Feishu Base has a "remind N days before a deadline" primitive; multitable had **no date-driven trigger** —
its automation triggers were all event-driven (`record.*`, `form.submitted`, `comment.created`) or fixed
wall-clock (`schedule.cron` / `schedule.interval`). There was no way to fire "N days before/after the value
of a record's date field". This adds that primitive: `schedule.date_field`.

## 2. What it is

A new trigger type `schedule.date_field` with config `{ dateFieldId, offsetDays, direction: 'before'|'after',
timeOfDay?, timezone?, scanIntervalMs? }`. It is **data-driven**: every record has its own occurrence derived
from its date field. A daily scan (leader-only, like cron) finds records whose occurrence is due, claims each
in an idempotency ledger, and fires the rule once per due record with the record as context — so downstream
actions (`send_notification`, `update_record`, …) resolve the record's fields normally.

## 3. Design — the two things that make it correct (advisor-shaped)

### Idempotency: occurrence is a PURE, day-bucketed key + claim-then-fire
- `computeDateReminderOccurrence(dateValue, config)` is a **pure function** — it never reads NOW. The dedup key
  is `(rule, record, occurrence)`; if tick time leaked into the occurrence, every tick would re-fire.
- The occurrence is **day-bucketed** (UTC): the source date's time-of-day is stripped before the ±offsetDays
  shift, then `timeOfDay` sets when on the reminder day it fires. Editing the deadline's *time* within the same
  reminder day does **not** change the occurrence → no re-spam.
- **Claim-then-fire** = AT-MOST-ONCE: `INSERT … ON CONFLICT DO NOTHING RETURNING` into
  `meta_automation_date_reminder_fires`, fire **only** when the insert won. A crash in the gap drops that one
  reminder (the documented at-most-once semantic) — preferable to at-least-once double-reminders.

### Firing window: bounded so a fresh rule never backfill-blasts
`isDateReminderDue(occ, now, scanWindow, ruleCreatedAt)` fires iff **all** hold (each an explicit product
semantic, golden-locked):
- `occ <= now` — due;
- `occ > now - scanWindow` — within the recent window (a replica down longer than the window skips missed
  reminders rather than replaying history; `scanWindow = 2× cadence`);
- `occ >= ruleCreatedAt` — a rule never reaches into the past relative to when it was authored.

Without the lower bound, creating a rule on a sheet of 1,000 dated records would blast 1,000 reminders on the
first scan. The combined bound makes the answer **zero**. (Advisor's day-one failure mode — the first thing a
reviewer probes; locked by DR-3.)

### Scan pushes the coarse filter into SQL
Date fields are stored as `toISOString()` (UTC). ISO strings sort chronologically, so the candidate window is a
plain string `BETWEEN` — no `::timestamptz` cast that could throw on legacy junk. The exact predicate
(`isDateReminderDue`) runs in JS on the bounded candidate set.

## 4. Files

Backend: `automation-date-reminder.ts` (pure core, new) · `automation-triggers.ts` (type) ·
`automation-scheduler.ts` (register the scan cadence) · `automation-service.ts` (`evaluateDateReminders`
scan/claim/fire + `runDateReminderScanNow` ops/test seam + VALID_TRIGGER_TYPES + 3 registration points) ·
migrations: `…_add_date_field_trigger_type` (widen CHECK) + `…_create_date_reminder_fires` (ledger, FK
ON DELETE CASCADE). Frontend: `types.ts` · `meta-automation-labels.ts` · `MetaAutomationRuleEditor.vue`
(trigger option + date-field/offset/direction/time config + submit normalization).

## 5. Verification

- **Pure unit (no DB) — 16/16:** occurrence purity + day-bucketing + before/after/offset/default-time +
  null-safety; firing-window (due / future / out-of-window / before-creation); clamp; candidate range.
- **Real-DB integration — 5/5** (`multitable-date-reminder-trigger.test.ts`, wired into `plugin-tests.yml`):
  DR-1 due record fires once (claim row + `update_record` marker stamped via the record context) · DR-2
  idempotent (no new claim, no new execution on re-scan) · **DR-3 backfill bound** (the same due record under a
  FRESH rule does NOT fire — occurrence < created_at) · DR-6 date edited to a new reminder-day fires a new
  occurrence, old stays deduped.
- **Two fail-first proofs:** disabling the dedup guard → DR-2 RED (re-fire); disabling the `created_at`
  predicate → DR-3 RED (fresh rule backfills `claimCount=1`). Both restored → green.
- **Typecheck:** backend `tsc --noEmit` exit 0; frontend `vue-tsc -b` exit 0; editor + labels specs 106/106
  (trigger-option count 7→8 updated in place; a new render test added).

## 6. Boundaries / deferred (named, not silent)

- **Retention/aging** of `meta_automation_date_reminder_fires` is NOT built — rows are reaped on rule delete
  (FK CASCADE) but long-lived rules grow the ledger. Deferred debt (the NiFi provenance benchmark flagged
  retention as the bounded gap); a separate aging slice.
- **Timezone:** v1 buckets in UTC (date fields are stored UTC). `timezone` is persisted but only `'UTC'` is
  honored; tz-aware day boundaries need an IANA tz library — deferred.
- **Sub-day offsets:** day-bucketing assumes whole-day `offsetDays`; hour-level offsets would revisit the key
  granularity — out of v1.
- At-most-once (not at-least-once) is the chosen v1 delivery semantic (documented in code).
