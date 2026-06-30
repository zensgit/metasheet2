# Design-lock — `date_field` reminders treat a `date`-type field as a FLOATING calendar day (Option 1)

> Small, self-contained correctness arc. **Not** mixed with R1 (BPMN/SSRF). Fixes the owner-ratified P2:
> a `date`-type trigger field + a negative-offset (Western-hemisphere) timezone fires the reminder **one
> calendar day early**. Surfaced from the T2-5 (#3401) DST work; the underlying facts predate T2-5 but #3401
> is the change that made the negative-offset path reachable. Owner ratified **Option 1** on 2026-06-30.

## 1. The defect (locked by the finding, re-stated for the record)

`schedule.date_field` rule, trigger field is a **`date`-type** field (date-picker writes a bare `YYYY-MM-DD`),
configured with a **negative-offset IANA tz** (`America/*`) → reminder fires one day early. Empirical, on the
merged T2-5 code, "3 days before `2026-03-08`, 09:00":

| timezone | occurrence (UTC) | local | verdict |
|---|---|---|---|
| `America/New_York` | `2026-03-04T14:00:00.000Z` | **Mar 4** 09:00 | ❌ should be Mar 5 |
| `UTC` | `2026-03-05T09:00:00.000Z` | Mar 5 | ✅ |
| `Asia/Shanghai` (+8) | `2026-03-05T01:00:00.000Z` | Mar 5 09:00 | ✅ |

**Root cause (two pre-existing facts that interact only once a non-UTC tz is honored):**
1. `field-codecs.ts:1096-1097` — the value codec normalizes `dateTime` → full UTC ISO (`toISOString()`), but
   **`date` has no case** and falls through to `return value` verbatim → a `date` field stores a bare
   `YYYY-MM-DD`.
2. `automation-date-reminder.ts:216` — the zoned day-bucket does `getZonedParts(t, tz)` where `t` is
   `new Date('2026-03-08')` = UTC midnight. In a negative-offset zone, UTC-midnight's **local** day is the
   PREVIOUS day → the entire offset/timeOfDay computation is anchored one civil day early.
3. `validateDateFieldTriggerAtSave` accepts **both** `date` and `dateTime` trigger fields.

## 2. Decision — Option 1: a `date` value is a FLOATING calendar day

A date-only field has **no instant**. `2026-03-08` means "the calendar day the user picked", and its day must
**not** move with timezone. So:

- **`date`-type field (floating):** derive the anchor calendar day from the **literal `YYYY-MM-DD`** (not by
  parsing to a UTC instant and re-zoning). Shift by ±`offsetDays` civil days, then place `timeOfDay` as the
  **local** wall-clock in `config.timezone` and convert that to a UTC instant.
- **`dateTime`-type field (instant):** UNCHANGED — `getZonedParts(instant, tz)` → local day → shift → local
  `timeOfDay`. A real instant legitimately belongs to different civil days in different zones; that is correct.
- **UTC / no-tz path:** UNCHANGED for both (literal UTC parts already equal the floating day).

**Rejected alternatives (owner-confirmed):** Option 2 (codec-normalize `date` → local-noon) touches global
storage semantics — far larger blast radius. Option 3 (forbid non-UTC tz on `date` fields) is too conservative
— it removes the most common date-reminder configuration (a localized day reminder).

## 3. Implementation (the small arc — 5 points)

**P1 — `computeDateReminderOccurrence` gains floating semantics.** Add a 3rd param
`opts: { floating?: boolean } = {}` (NOT a new persisted config key — the flag is derived from the field type
at scan time, not stored). When `floating`:
  - Resolve the anchor day from the bare value: regex `^(\d{4})-(\d{2})-(\d{2})` → `{year, month, day}`; if the
    value is a `Date` or a non-matching string, fall back to the parsed instant's **UTC** parts (a `date`
    stored as full-ISO-midnight still yields the right civil day). Absent/unparseable → `null` (unchanged).
  - Use that day in BOTH the UTC branch and the zoned branch **in place of** `getZonedParts(t, tz)`. Everything
    downstream (civil-day shift, `zonedWallClockToUtcMs(timeOfDay)`, junk-tz→UTC catch) is unchanged.
  - Default (`floating` absent/false) = today's instant semantics → **byte-identical** for every existing
    caller and golden.

**P2 — `evaluateDateReminders` plumbs the field type.** After the config validation (automation-service.ts
~1223), do ONE `SELECT type FROM meta_fields WHERE sheet_id = $1 AND id = $2` for `dateFieldId` (mirrors
`validateDateFieldTriggerAtSave`; one query per scan, not per record). `floating = fieldType === 'date'`,
passed to `computeDateReminderOccurrence(data[dateFieldId], config, { floating })`. **Fail-closed on the field
type:** if the row is MISSING (deleted) or NO LONGER `date`/`dateTime` (retyped to string/etc.), **skip the
scan** (`return` + warn) — do NOT fall through to instant. The record JSONB can retain the stale `dateFieldId`
key after a delete/retype, so `data ->> dateFieldId` may still match; relying on "candidates matches nothing"
would fire reminders for a field that is no longer a date trigger (and for a former `date` field, at the
day-early value). Locked by real-DB `DR-GONE` (retype→string AND field-delete, both RED-before).

**P3 — SQL pre-filter boundary, made exact for bare dates.** `dateReminderCandidateDateRange` returns full-ISO
bounds; the candidates query compares `data->>field BETWEEN lo AND hi` lexicographically. A bare `YYYY-MM-DD`
that equals the `lo` **date** sorts BEFORE a full-ISO `lo` (the bare string is a prefix) → it can be wrongly
excluded at the exact boundary day. Fix: return **date-only, widened** bounds — `loBound = dateOnly(lo)` (start
of the lo civil day) and `hiBound = dateOnly(hi + 1 day)` (start of the day after hi). Both bare `YYYY-MM-DD`
and full-ISO stored values then fall inside by lexicographic compare; the result is a strict **superset** of
today's window (the exact gate stays the JS `isDateReminderDue`). Update the `dateReminderCandidateDateRange`
unit assertions to the new bounds.

**P4 — Goldens.**
  - *Pure unit* (`automation-date-reminder.test.ts`): floating `2026-03-08` + `America/New_York` + 3-before +
    09:00 → `2026-03-05T14:00:00.000Z` (Mar 5 09:00 EST). The SAME inputs with `floating:false` →
    `2026-03-04T14:00:00.000Z` (documents that the day-early value is *correct* for a true instant). Plus:
    floating `Asia/Shanghai` (positive offset, no shift either way) and floating UTC-path unchanged.
  - *Real-DB* (`tests/integration/multitable-date-reminder-trigger.test.ts`): a `date`-type record storing a
    **bare `YYYY-MM-DD`** (as the date-picker writes — the existing fixtures store full ISO and so never
    exercised this path) + `America/New_York` rule fires once through the **real SQL pre-filter**, and the
    ledger `occurrence_ts` equals the corrected floating-day instant (the buggy value would be one civil day
    earlier). This single test covers both the bare-date SQL fetch (P3) and the occurrence correctness (P1+P2).
    The file is already in `plugin-tests.yml:298` → CI-covered.

**P5 — Fix the DST golden comment.** The block added in #3401
(`automation-scheduler-date-reminder.test.ts`) currently describes the bare-date day-bucketing **neutrally as
"how it works"**. Update the comment so it no longer reads as blessing the day-early behavior, and note that
the floating fix changes the `date`-type day-derivation while the DST gap/overlap clock behavior it tests is
unaffected (it uses `dateTime`-style instant inputs).

## 4. Compatibility / re-fire note

For an affected rule (floating field + negative-offset tz) with a due occurrence in the 48h window at deploy,
the corrected `occurrence_ts` is a NEW dedup key → a **bounded one-time re-fire** is possible — identical to
the already-accepted "editing a rule's timezone re-buckets `occurrence_ts`" semantic (Q5, the module header).
It self-corrects to the right day thereafter; historical ledger rows are never rewritten. CN/positive-offset
and UTC tenants, and all `dateTime`-field rules, see **no change**.

## 5. Verification gate

tsc 0 · `automation-date-reminder.test.ts` + `automation-scheduler-date-reminder.test.ts` green · the new
real-DB golden green against local Postgres · `dateReminderCandidateDateRange` unit assertions updated · the
full automation-v1 suite unchanged on the UTC/`dateTime` paths · adversarial verification pass over the diff
(boundary dates, month/year rollover, leap day, DST-gap-on-floating-date, dedup-key stability). Then PR →
rebase → CI green → merge, per the standing gate. **R1 follows after this lands.**

## 6. Adversarial verification outcome (5-skeptic panel over the built diff)

All five dimensions returned **solid**: occurrence-edges (month/year/leap/junk rollover all identical between
floating and instant — divergence is ONLY the intended literal-day source), **SQL superset** (brute-forced
thousands of due records across date-line / DST / leap zones — **zero false-negatives**), dateTime-unchanged
(byte-identical for `floating=false`, line-by-line), scanner-plumbing, and re-fire/dedup (re-fire stays bounded
to at-most-once). Two `isReal` **P3** edge findings were folded in (both adjacent to the new scan block):

- **Transient `meta_fields` read failure → day-early spurious fire.** The catch originally defaulted
  `floating=false`, which for a `date`-field in a negative-offset tz emits the *buggy* day-early occurrence as
  its one allowed re-fire. Changed to **skip the scan tick** (`return`) — the grace window + next tick recover
  it with no wrong-day fire. Locked by real-DB `DR-SKIP-ON-READ-FAIL` (RED-before: it fired the day-early one).
- **`dateFieldId` trim parity (pre-existing).** The save validator trims before its lookup but the scan read
  the id un-trimmed, so a whitespace-padded id passed save then silently no-op'd at scan. The scan now trims
  once (aligns both the new type read and the existing `data ->> dateFieldId` candidates key). Locked by
  real-DB `DR-TRIM` (RED-before: the padded rule fired nothing).

Out-of-scope note (NOT fixed here — flagged for a separate item): `validateDateFieldTriggerAtSave` doesn't cap
`offsetDays` magnitude, so an absurd value (e.g. 1e12) makes `dateReminderCandidateDateRange` throw `RangeError`
and aborts that rule's scan. Pre-existing, orthogonal to floating, and a total-skip (not a per-record
false-negative); left for a follow-up so this arc stays small.

## 7. Owner review (PR #3417) — P2 fix

The owner caught a **P2** the adversarial panel rated only P3: the original scan block set
`floating = ft === 'date'` and **fell through** for a missing/retyped field — the docstring *claimed* skip but
the code did not, and the "candidates matches nothing" assumption is unsafe because a record's JSONB keeps the
stale `dateFieldId` key after a field delete/retype. So a `date_field` rule whose trigger field was deleted or
retyped to `string` would keep firing reminders off the stale key (and a former `date` field would fire the
day-early value). Fixed with a fail-closed guard: proceed only when the field is `date`/`dateTime`, else skip
the scan. Locked by `DR-GONE`. (Non-blocking confirmations accepted: relative real-DB golden is correct;
`dateFieldId.trim()` stays in this arc, not peeled; skip-whole-tick on a read throw is the right posture; the
`offsetDays` `RangeError` is a fine separate follow-up.)
