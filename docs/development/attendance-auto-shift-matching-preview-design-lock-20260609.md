# 自动对班 preview design-lock（SHOULD / 灰度门）

Date: 2026-06-09
Baseline: `origin/main` @ `c667ba137`
Status: A0/A1 shipped and staging-proven; A2 auto-write remains locked behind a separate design.

## 0. Why This Exists

The H2 tracker now has all MUST items closed. The next useful attendance line is
the SHOULD item **自动对班**: when a scheduled-shift employee has punches but no
explicit schedule for the day, the system can suggest the most likely shift for
an admin to review.

This is useful, but dangerous if shipped as automatic write-first behavior:

- a wrong match changes planned attendance;
- planned attendance feeds compliance, records, reports, overtime/leave conflict
  checks, and future payroll-adjacent views;
- undo after derived writes is harder than rejecting a bad suggestion.

Therefore v1 is **preview first** and **feature-flag default off**. No background
auto-write is allowed until the preview/apply chain has real operator evidence.

## 1. Existing Grounding

| Surface | Current state | Design consequence |
| --- | --- | --- |
| Fixed-schedule group preview/apply | `buildAttendanceGroupFixedSchedulePlan` previews/applies group fixed schedules and intentionally is not automatic shift matching. | Reuse the preview/apply discipline, not the business meaning. 自动对班 is per user/day from punches; fixed-schedule is per group/date range from a chosen shift. |
| Scheduled/unscheduled truth | `isUserScheduledForDate` is the shared truth for unscheduled punch policy and unscheduled reminder. | A0 must reuse this truth: only scheduled-shift users that are unscheduled for the work date are eligible. |
| Work context / metrics | `resolveWorkContext*` and `computeMetrics` own the effective-calendar + metrics path. | Preview must not invent record metrics; it only proposes a shift assignment candidate. Records remain recomputed by existing paths after an accepted assignment. |
| Shift assignment save paths | Shift/rotation/fixed-apply already have edit-window and compliance guards. | A1 apply must go through the existing assignment write path or the same guard stack; no side-door insert. |
| In/out merge / outdoor approvals | Recent punch-policy work proved record/event classification can be subtle. | Matching uses approved/persisted punch facts only; pending outdoor approvals and forged sources are not inputs. |

## 2. Product Scope

### In

- Suggest a shift for **unscheduled scheduled-shift employees** from same-day punch
  times.
- Admin can inspect the suggestion before any schedule write.
- Matching is deterministic and explainable: every suggestion carries score and
  reasons.
- Default is off and read-only preview is the first implementation slice.

### Out

- No automatic write in A0.
- No overwrite of existing manual/import/fixed/rotation assignments.
- No multi-slot matching in v1.
- No cross-day/overnight shift matching in v1 unless a later design explicitly
  defines the date attribution.
- No mobile employee-facing auto confirmation.
- No payroll or overtime recalculation beyond what existing record/report
  recomputation already does after a real accepted assignment.

## 3. Eligibility

A user/day is eligible only when all are true:

1. runtime flag and org settings both enable automatic shift matching preview;
2. user is in an attendance group whose `attendance_type` is `scheduled_shift`;
3. `isUserScheduledForDate(orgId, userId, workDate)` returns false;
4. there is no active `attendance_shift_assignments` or
   `attendance_rotation_assignments` row covering that user/day;
5. at least one usable punch exists for that user/day;
6. the day is inside the configured preview window;
7. the target shift is active and belongs to the org.

The fixed/free attendance groups are intentionally **not applicable**. This
inherits the same applicability boundary as unscheduled-punch and unscheduled
reminder: fixed/free groups must not be misclassified as "missing a schedule".

## 4. Matching Model

### Inputs

- `attendance_events` for user/day, after existing S2 outdoor approval semantics:
  only events that have become real attendance events count.
- Candidate `attendance_shifts` in the org, optionally narrowed by the user's
  attendance group / schedule group if that data is available in the slice.
- Existing work-date timezone resolution from attendance settings/rules.

### v1 Candidate Score

For each candidate shift:

- compare earliest check-in to shift start;
- compare latest check-out to shift end;
- compute total absolute delta in minutes;
- apply penalties for missing in/out, excessive early/late deltas, or only one
  punch;
- reject candidates beyond a max tolerance.

The preview item must include:

- `userId`, `workDate`;
- `candidateShiftId`, `candidateShiftName`;
- `score`;
- `confidence`: `high | medium | low`;
- `reasons[]`: human-readable structured reason codes, e.g.
  `nearest_start`, `nearest_end`, `single_punch_low_confidence`,
  `outside_tolerance`;
- punch evidence snapshot: first/last punch timestamps and event ids.

No model/AI inference is introduced. It is an explainable deterministic matcher.

## 5. Write Model

### A0 Preview

Read-only endpoint returns suggestions. It writes nothing.

Suggested endpoint:

`POST /api/attendance/auto-shift-matching/preview`

Input:

```json
{
  "from": "2026-06-01",
  "to": "2026-06-07",
  "userIds": ["u1"],
  "attendanceGroupIds": [],
  "maxToleranceMinutes": 120
}
```

Output:

```json
{
  "items": [
    {
      "userId": "u1",
      "workDate": "2026-06-03",
      "candidateShiftId": "shift-1",
      "confidence": "high",
      "score": 15,
      "reasons": ["nearest_start", "nearest_end"],
      "evidence": {
        "firstInAt": "2026-06-03T09:05:00.000Z",
        "lastOutAt": "2026-06-03T18:03:00.000Z",
        "eventIds": ["..."]
      }
    }
  ],
  "skipped": [
    {
      "userId": "u2",
      "workDate": "2026-06-03",
      "reason": "already_scheduled"
    }
  ]
}
```

### A1 Admin Apply

Admin applies selected suggestions only. Apply must:

- acquire the same per-user schedule assignment lock used by existing assignment
  writes;
- re-run eligibility and matching inside the transaction;
- insert `attendance_shift_assignments` through the existing guard stack or a
  shared helper that runs edit-window + compliance checks;
- stamp provenance:
  - `producer_type='auto_shift_match'`;
  - `producer_ref_id` = preview/apply run id;
  - `producer_key` = deterministic `userId:workDate`;
  - `producer_run_id` = apply run id.

If eligibility changed between preview and apply, the item is skipped with a
reason instead of forcing a write.

### A2 Auto-write

Not allowed until A0+A1 have shipped and staging evidence shows low false
positive risk. A2 requires a separate opt-in design:

- feature flag default off;
- org setting default off;
- high-confidence only;
- daily cap on writes;
- audit log and rollback route;
- staging smoke and at least one real operator review loop.

## 6. Settings / Flags

Do not add a DB table in A0. Use org attendance settings plus a runtime flag:

- runtime flag: `ATTENDANCE_AUTO_SHIFT_MATCHING_ENABLED=true`;
- org setting: `autoShiftMatching.enabled=true`.

```json
{
  "autoShiftMatching": {
    "enabled": false,
    "mode": "preview",
    "maxToleranceMinutes": 120,
    "minConfidenceToApply": "high"
  }
}
```

Rules:

- default unset/false = no behavior change;
- `mode='preview'` only returns suggestions;
- `mode='apply'` is not exposed until A1;
- `mode='auto'` is reserved and must not be accepted until A2.

## 7. UI

A0 UI is an admin review surface, not a background automation dashboard.

Recommended placement:

- Attendance admin scheduling area, near "排班分配" / "未排班提醒" context;
- filter by date range and group;
- rows show punch evidence, suggested shift, confidence, and skip reason;
- no one-click "apply all" in A0.

A1 may add selected apply after the backend apply endpoint exists.

## 8. Tests Required Before Runtime Merge

A0:

- default flag/setting off: endpoint returns `403 AUTO_SHIFT_MATCHING_DISABLED`
  and writes nothing;
- scheduled-shift unscheduled user with two punches gets one deterministic
  candidate;
- already scheduled user is skipped;
- fixed/free group user is skipped;
- pending outdoor approval is not counted as punch evidence;
- candidate outside tolerance is skipped or low-confidence, per contract;
- no `attendance_shift_assignments` row is written by preview.

A1:

- preview→apply writes exactly one assignment with provenance;
- re-running apply for same suggestion is idempotent / skipped, not duplicated;
- assignment edit-window and shift-compliance guards still block writes;
- existing manual/import/fixed/rotation assignment is not overwritten;
- stale preview is rejected when punches or assignments changed;
- rollback/clear behavior for `producer_type='auto_shift_match'` is explicitly
  tested or explicitly out of scope.

A2:

- separate staging smoke with feature flag on and high-confidence only;
- repeat scheduler/worker tick does not duplicate writes;
- low-confidence suggestions never auto-write.

## 9. Slice Plan

| Slice | Scope | Status |
| --- | --- | --- |
| D0 | This design-lock + tracker backfill | ✅ design-lock landed |
| A0 | Backend preview endpoint + unit/real-DB tests; no writes | ✅ #2403 |
| A0-UI | Admin review table for suggestions | ✅ #2405 |
| A1 | Admin selected apply, provenance, guard reuse | ✅ #2406 + staging PASS `A1_AUTO_SHIFT_STAGING_SMOKE_PASS` |
| A1-UI | Apply selected suggestions | ✅ #2406 + staging PASS `A1_AUTO_SHIFT_STAGING_SMOKE_PASS` |
| A2 | Automatic write, feature-flag default off, staging smoke | 🔒 separate design-lock |

## 10. Completion Bar

自动对班 A0/A1 is ✅ as of 2026-06-09: A0 preview and A1 admin apply are both
merged and staging-proven. The staging smoke ran on deploy
`b4a1ca69323d767e7d838882751b365f18b4116f` and proved:

- feature is admin-configurable;
- no default behavior changes;
- preview is explainable;
- apply is explicit and guarded;
- reverse tests prove no overwrite of existing assignments;
- one staging smoke proves preview/apply with real records.

Smoke stamp:
`A1_AUTO_SHIFT_STAGING_SMOKE_PASS deploy=b4a1ca69323d767e7d838882751b365f18b4116f prefix=autoshift-a1-smoke-mq64a66m residue={"users":0,"events":0,"records":0,"assignments":0,"groups":0,"shifts":0}`.

A2 auto-write is optional and does not block the SHOULD ✅ unless product later
raises the bar.
