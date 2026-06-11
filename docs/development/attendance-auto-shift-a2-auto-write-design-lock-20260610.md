# 自动对班 A2 自动写入 design-lock（H2+ / guarded auto-write）

Date: 2026-06-10
Baseline: `origin/main` @ `a2ee0a12d`
Status: design-lock only; no runtime, scheduler, schema, UI, OpenAPI, or staging change in this PR.

## 0. Why This Exists

The previous auto-shift matching line is closed through A1:

- A0 preview returns deterministic suggestions from punch evidence and writes no
  schedule assignment.
- A1 admin-selected apply re-runs eligibility in the transaction, writes one
  guarded assignment with `producer_type='auto_shift_match'`, and is
  staging-proven.

A2 is different: it lets the system write a schedule assignment without a human
click on that specific suggestion. A wrong automatic match can affect planned
attendance, shift-compliance caps, overtime/leave reasoning, records, reports,
and future payroll-adjacent views. Therefore A2 is allowed only as a separate
guarded auto-write line.

This design-lock makes A2 a new **H2+** target: it builds on the H2 closeout but
does not reopen that goal.

## 1. Existing Grounding

| Surface | Current state | A2 consequence |
| --- | --- | --- |
| Runtime flag | `ATTENDANCE_AUTO_SHIFT_MATCHING_ENABLED` gates A0/A1. | A2 must add a second explicit auto-write flag; A0/A1 enablement is not enough. |
| Org settings | `autoShiftMatching.enabled`, `mode='preview'|'apply'`, tolerance, and min confidence are persisted. `mode='auto'` is not accepted. | A2 may introduce `mode='auto'` only after a dormant config slice proves default-off round-trip and strict schema behavior. |
| Preview route | `POST /api/attendance/auto-shift-matching/preview` is admin-only and returns `items` + `skipped`. | A2 candidate discovery must reuse the same matcher output shape; no second matcher. |
| Apply route | `POST /api/attendance/auto-shift-matching/apply` is admin-only, re-runs matching in a transaction, checks evidence ids, acquires per-user locks, runs scheduler-scope dispatch checks, shift edit-window, conflict guard, and shift-compliance cap, then writes provenance. It currently performs an inline guarded insert rather than calling the manual assignment route. | A2 auto-write must reuse the same guarded apply helper after extraction. If the helper is not reusable yet, first extract it without changing behavior. |
| Provenance | A1 writes `producer_type='auto_shift_match'`, deterministic `producer_key=userId:workDate`, and `producer_run_id`. | A2 must keep the same producer type/key for idempotence, while distinguishing the run source in audit output. |
| UI | `AttendanceView.vue` exposes preview/apply controls and explicitly says selected apply, not background auto-write. | A2 UI is a separate operations card; it must not silently repurpose the A1 card. |

## 2. Owner Decisions Locked

1. **Default off at every gate.** A2 requires all five gates:
   `ATTENDANCE_AUTO_SHIFT_MATCHING_ENABLED=true`,
   `ATTENDANCE_AUTO_SHIFT_AUTO_WRITE_ENABLED=true`,
   `autoShiftMatching.enabled=true`,
   `autoShiftMatching.mode='auto'`, and
   `autoShiftMatching.autoWrite.enabled=true`. Missing any one means no
   background writes.
2. **High-confidence only in v1.** A2 ignores `medium` and `low` suggestions,
   even if A0/A1 settings allow lower confidence for preview or manual apply.
3. **Reuse A1 apply guard stack.** A2 must not insert directly into
   `attendance_shift_assignments` through a new side door.
4. **No overwrite.** A2 never overwrites manual/import/fixed/rotation/temp/
   published assignment facts. Existing schedule coverage yields a skipped row.
5. **Scheduled-shift only.** Fixed-shift and free-time groups remain
   non-applicable.
6. **No multi-slot auto-write in v1.** A2 writes slot `0` only, and skips a
   user/day that already has any active schedule coverage.
7. **No overnight/cross-day matching in v1.** Candidate shifts with overnight
   windows stay out of the matcher, as A0/A1 do today.
8. **Staging before complete.** A2 is not complete until the background path is
   exercised on staging with residue 0.

## 3. Product Scope

### In

- Automatically apply only `high` confidence suggestions for scheduled-shift
  users that are unscheduled for the target work date.
- Run in a bounded date window, initially "tomorrow" or a configured lookahead
  of 1 day. Wider scans require a later opt-in.
- Produce a durable run summary: scanned users/days, candidates, applied,
  skipped, and error counts.
- Surface recent A2 runs and skip reasons to administrators.
- Preserve A0 preview and A1 manual apply behavior exactly.

### Out

- No direct employee-facing confirmation flow.
- No automatic writes for `medium` or `low` confidence.
- No "apply all" bypass in the UI.
- No multi-slot, rotation, temporary-shift replacement, overnight, or cross-day
  matching.
- No payroll, compensation, or retrospective record rewrite beyond existing
  schedule-derived recomputation paths.
- No C5 external notification delivery. A2 may emit internal audit/events only.

## 4. Settings And Flags

Extend org settings only after the dormant config slice:

```json
{
  "autoShiftMatching": {
    "enabled": false,
    "mode": "preview",
    "maxToleranceMinutes": 120,
    "minConfidenceToApply": "high",
    "autoWrite": {
      "enabled": false,
      "lookaheadDays": 1,
      "maxAssignmentsPerRun": 25,
      "minConfidence": "high"
    }
  }
}
```

Rules:

- unset / absent `autoWrite` = no behavior change;
- `mode='auto'` is rejected until the slice that wires the background path;
- `autoWrite.enabled=true` is inert unless `autoShiftMatching.enabled=true`,
  `mode='auto'`, and both runtime flags are also enabled;
- `autoWrite.minConfidence` must be `high` in v1; lower values are rejected, not
  silently clamped;
- `autoWrite.lookaheadDays` must be a bounded integer in `[1, 3]` (default `1`);
  larger windows are rejected, not clamped, so one misconfiguration cannot turn
  a tick into a broad historical writer;
- `maxAssignmentsPerRun` is required before any background writer can run; it is
  the blast-radius fuse for bad matching, and v1 must bound it to a documented
  upper limit before the scheduler is enabled.

## 5. Execution Model

### A2-0 Dormant Config

- Add settings shape and validation.
- Keep `mode='auto'` rejected in A2-0. The slice may persist the nested
  `autoWrite` defaults, but the user-visible mode must not advertise automatic
  writes before the writer ships.
- Add tests proving default-off and strict body behavior.

### A2-1 Shared Apply Helper

Before adding a worker, extract the A1 transaction body into a shared helper that
can be called by:

- the existing admin-selected apply route;
- the future A2 background runner.

The helper must continue to:

- acquire the per-user assignment lock;
- check deterministic `producer_key=userId:workDate` for idempotence;
- reject existing schedule coverage;
- re-run preview/matching inside the transaction;
- compare evidence event ids;
- run scheduler-scope dispatch permission for the actor context;
- run shift edit-window and shift-compliance cap;
- stamp the same provenance.

The helper must accept an explicit actor context. A1 continues to use the request
actor. A2 may use a system actor only after the implementation names how
scheduler-scope enforcement treats system writes and tests that it cannot bypass
tenant/org boundaries. If that is not ready, A2-1 must keep the worker disabled.

### A2-2 Background Runner

The first live runner should be an env-gated attendance scheduler job, reusing
the existing `AttendanceScheduler` pattern instead of creating another cron
base.

Before A2 adds its job, `AttendanceScheduler` must be refactored from the
current expiry + optional single reminder-job shape into an explicit job list or
composite runner. The refactor is part of A2-2, not a deferred cleanup, because
⑤ unscheduled reminders already occupy the optional reminder slot. A2 must not
replace, disable, or reorder the existing expiry and unscheduled-reminder jobs
as a side effect of wiring auto-write.

Runner rules:

- scan only the configured lookahead window;
- candidate discovery uses `buildAutoShiftMatchingPreview` semantics;
- apply only `confidence='high'`;
- stop after `maxAssignmentsPerRun`;
- record skipped reasons, not just failures;
- repeat tick is idempotent due to deterministic producer key;
- any error for one user/day must not abort cleanup/audit for the whole run.

### A2-3 Admin Operations Surface

Add a separate admin card, not an implicit mode change in the A1 card:

- show auto-write enabled/off status and runtime flag state if available;
- show lookahead, max per run, and min confidence;
- show recent run summaries and skipped reasons;
- expose a kill-switch save action;
- do not expose "force write" for arbitrary suggestions.

## 6. Audit, Rollback, And Observability

Minimum v1 audit:

- `producer_type='auto_shift_match'`;
- deterministic `producer_key=userId:workDate`;
- `producer_run_id` = auto-run id;
- run summary includes start/end timestamps, config snapshot, applied/skipped
  counts, and error counts.

Rollback:

- v1 rollback / clear semantics for automatic writes must be keyed by
  `producer_run_id`. A broad `producer_type='auto_shift_match'` delete is
  forbidden because A1 admin-approved applies and A2 background writes share the
  same producer type.
- No broad delete by date range without producer-run filters.

Observability:

- log the run id and counts;
- never log raw tokens or full user records;
- expose a failed/partial run status if the scheduler crashes mid-run.

## 7. Required Tests

A2-0:

- default settings do not enable auto-write;
- strict settings validation rejects unsupported `autoWrite.minConfidence` and
  invalid caps, including `lookaheadDays < 1` or `lookaheadDays > 3`;
- A0/A1 tests remain green.

A2-1:

- admin apply route still writes one assignment with identical response shape;
- helper rejects stale evidence and existing schedule coverage;
- shift edit-window and shift-compliance still block;
- deterministic producer key makes replay skip, not duplicate.

A2-2:

- scheduler refactor proves expiry, unscheduled-reminder, and auto-shift jobs
  can all be registered and run in one cycle, with one job failure not skipping
  the rest;
- env flag off: scheduler job does not write;
- org setting off: scheduler job does not write;
- high-confidence eligible row writes exactly one assignment;
- medium/low confidence rows are skipped;
- existing manual/import/fixed/rotation/temp/published assignment is not
  overwritten;
- repeat tick does not duplicate;
- maxAssignmentsPerRun caps writes and leaves the rest as skipped/pending;
- fixed/free users are skipped by the same applicability boundary as A0/A1.
- rollback/runbook test proves A2 cleanup targets a specific `producer_run_id`
  and cannot delete A1 admin-approved `producer_type='auto_shift_match'` rows
  from another run.

A2-3:

- UI saves only the A2 settings sub-shape it owns;
- disabled/off state is visually obvious;
- recent run list renders applied and skipped counts;
- no UI path posts directly to assignment create routes.

Staging:

- deploy with both A2 runtime flags;
- seed scheduled-shift users with high, medium, existing-scheduled, and fixed/free
  cases;
- run one scheduler tick;
- assert exactly the high-confidence unscheduled row is written;
- repeat tick writes zero duplicates;
- cleanup residue 0.

## 8. Slice Plan

| Slice | Scope | Status |
| --- | --- | --- |
| D0 | This design-lock + tracker backfill | ✅ |
| A2-0 | Dormant settings + strict validation, no writer | ✅ |
| A2-1 | Shared apply helper extraction; A1 route no behavior change | 🟡 runtime PR |
| A2-2 | Accept `mode='auto'` + env-gated scheduler job + high-confidence auto-write | 🟡 runtime PR |
| A2-3 | Admin operations card + run summaries | 🔒 |
| A2-4 | Staging smoke + tracker closeout | 🔒 |

## 9. Completion Bar

A2 is ✅ only when all of these are true:

- automatic write is gated by both runtime flags plus the three org conditions
  (`enabled`, `mode='auto'`, and `autoWrite.enabled`);
- only high-confidence suggestions are auto-applied;
- A2 uses the same guarded transaction path as A1;
- existing schedule facts are never overwritten;
- run audit and idempotence are tested;
- admin can disable the feature and inspect recent runs;
- one staging smoke proves high-confidence write, low-confidence skip,
  existing-schedule skip, repeat-tick idempotence, and residue 0.

Until then, A2 remains 🟡/🔒 and A0/A1 remain the only completed auto-shift
capability.
