# Attendance Group Fixed-Schedule FS-A/B/C Closeout

Date: 2026-05-28
Baseline: `origin/main` at `01c753a6b`
Status: closeout evidence only

## 1. Purpose

This note closes the fixed-schedule FS-A through FS-C chain before any FS-D design or runtime work starts.

It is intentionally not a live browser acceptance. The local browser is currently on the login page, so this note records post-merge source and CI evidence only. It does not claim an authenticated UI smoke passed.

## 2. Landed Chain

| Slice | State | Evidence |
| --- | --- | --- |
| FS-A design lock | Landed | `docs/development/attendance-group-admin-ux-fixed-schedule-design-20260528.md` |
| FS-B preview | Landed | `docs/development/attendance-group-admin-ux-fixed-schedule-preview-verification-20260528.md` |
| FS-C apply | Landed | `#1994`, squash `01c753a6b feat(attendance): apply fixed schedules for groups (#1994)` |

`#1994` merged at `2026-05-29T02:56:36Z`. The GitHub check rollup for the merged head had all real checks `SUCCESS`; `Strict E2E with Enhanced Gates` was the expected conditional `SKIPPED` gate.

## 3. Source Evidence On Main

All anchors below were verified on `origin/main` at `01c753a6b`.

| Claim | Evidence |
| --- | --- |
| Preview/apply share one classifier. | `plugins/plugin-attendance/index.cjs:8698`, `plugins/plugin-attendance/index.cjs:8836`, `plugins/plugin-attendance/index.cjs:8840` |
| Preview route exists. | `plugins/plugin-attendance/index.cjs:25843` |
| Apply route exists. | `plugins/plugin-attendance/index.cjs:25916` |
| Apply emits the existing assignment-created event for created rows, not a new event type. | `plugins/plugin-attendance/index.cjs:25977` |
| Frontend preview calls the group preview route. | `apps/web/src/views/AttendanceView.vue:16122` |
| Frontend apply calls the group apply route. | `apps/web/src/views/AttendanceView.vue:16162` |
| Apply button is bound to the dedicated availability guard. | `apps/web/src/views/AttendanceView.vue:3306`, `apps/web/src/views/AttendanceView.vue:8240` |
| Successful apply disables a second submit until a fresh preview. | `docs/development/attendance-group-admin-ux-fixed-schedule-apply-verification-20260528.md:60` |

## 4. Locked Behavior

- The group fixed-schedule path creates per-user `attendance_shift_assignments` only.
- Preview and apply use the same `buildAttendanceGroupFixedSchedulePlan` classification.
- Exact active shift assignment matches are `skipped`.
- Active overlapping non-exact shift rows and active overlapping rotation rows are `blockingConflicts`.
- Apply runs in a transaction, locks every target user, reruns the shared plan, inserts only `wouldCreate[]`, and writes nothing when any blocking conflict exists.
- The frontend posts to the group apply route, not `/api/attendance/assignments`.
- A successful apply disables the button and requires another preview before another apply.
- `attendance_schedule_groups` remains unrelated to this feature.

## 5. Still Not Solved

FS-C deliberately does not add producer/source metadata. Therefore it cannot safely promise managed-row rebuild, clear, or delete semantics.

Rows created by FS-C are ordinary shift assignments. Without provenance, a later feature cannot tell whether an exact assignment was created by the group fixed-schedule flow, a manual assignment, an import, or another future producer.

That is why FS-D remains a separate design-first opt-in.

## 6. Deferred

These remain gated and must not start from this closeout:

- producer/source metadata;
- managed-row rebuild/delete;
- migrations for assignment provenance;
- weekly matrix;
- daily multi-shift modeling;
- group-owned rotation generation;
- group-specific punch method configuration;
- owner/sub-owner roles;
- export/copy controls;
- comprehensive-hours writes from group detail.
