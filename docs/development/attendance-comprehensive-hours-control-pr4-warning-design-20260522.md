# Attendance Comprehensive Working Hours Control PR4 Warning Design

Date: 2026-05-22
Branch: `codex/attendance-comprehensive-hours-pr4-design-lock-20260522`

## Summary

PR4 is the first comprehensive-hours slice that may touch schedule-save UX. It
must remain a **weak-control warning** only. It may surface planned
comprehensive-hours over-cap warnings before or during schedule save, but it
must not block persistence, alter schedule write semantics, or persist a
comprehensive-hours policy.

This document is a design lock. Runtime implementation requires a separate
explicit go after review.

## Current Foundation

| Slice | Status | Role |
| --- | --- | --- |
| PR0 RFC | Merged | Product/technical roadmap. |
| PR1 helpers `#1770` | Merged | Pure comprehensive-hours calculators. |
| PR2 preview route `#1774` | Merged | Read-only backend preview route. |
| PR2.5 enum strictness `#1776` | Merged | Backend rejects invalid enum values instead of defaulting. |
| PR3 admin UI `#1777` | Merged | Read-only admin preview panel. |

## PR4 Objective

When an admin is editing or saving schedule data, show a warning if the planned
minutes for affected users exceed a draft comprehensive-hours cap for the
selected period.

The warning should answer:

- who is affected
- which period was checked
- planned minutes vs cap
- warning or violation status
- that saving is still allowed in PR4

## Hard Boundaries

| Boundary | Requirement |
| --- | --- |
| Weak control only | Save must remain allowed even when preview status is `warning` or `violation`. |
| No policy persistence | Do not add settings storage, catalog rows, migrations, or localStorage-backed policy persistence. |
| No backend block | Do not reject schedule save based on comprehensive-hours status. |
| No route multiplication | Reuse `POST /api/attendance/comprehensive-hours/preview`; do not add another comprehensive-hours calculation endpoint. |
| No actual-minute enforcement | PR4 warning uses planned metric only. Actual metric remains reporting/read-only. |
| Explicit scope | No all-users batch in save flow. Scope should be derived from the edited assignment user(s), capped by backend preview limits. |
| Existing write semantics | Existing schedule save success/failure behavior must remain unchanged. |
| PR5 deferred | Strong block-save guard remains a separate explicit opt-in slice. |

## Candidate Touch Points

PR4 should inspect the smallest save surfaces that create or update planned
schedule minutes:

| Surface | Existing shape | PR4 behavior |
| --- | --- | --- |
| Shift assignment save | single assignment user + date range | Preview the assignment user's planned period, show warning banner if over cap, still save. |
| Rotation assignment save | single assignment user + date range | Same as shift assignment. |
| Advanced scheduling workbench | read-only | No PR4 write behavior. May link operators back to preview UI only. |

Do not start with batch import, Excel-like grid edit, temporary line-draw shifts,
or all-users scheduler actions. Those are separate advanced-scheduling write
surfaces and remain outside PR4.

## Warning Flow

1. User edits a shift or rotation assignment.
2. UI derives a draft preview request:
   - `metric: 'planned'`
   - `scope: { userId }`
   - `period`: selected period from UI, or a conservative period inferred from
     assignment range only if product copy clearly labels it as inferred
   - `policyDraft`: cap/enforcement from in-memory form state only
3. UI calls `POST /api/attendance/comprehensive-hours/preview`.
4. If preview returns `warning` or `violation`, show a warning panel near the save
   button.
5. Save button remains enabled and still calls the original save function.
6. Optional: save completion may include a non-blocking toast that warnings were
   advisory.

## UX Copy Requirements

Warning text must avoid implying enforcement:

- Good: `Comprehensive-hours warning: planned minutes exceed the draft cap. Saving is still allowed in this stage.`
- Bad: `Blocked`, `Cannot save`, `Policy enforced`, `Violation prevented`.

The panel must include a clear read-only/advisory marker and, where possible,
link to the PR3 comprehensive-hours preview section for deeper inspection.

## Error Handling

| Preview result | PR4 behavior |
| --- | --- |
| `ok` | Show no warning, or show a compact OK status if preview was user-triggered. |
| `warning` / `violation` | Show advisory warning. Save remains allowed. |
| `400` validation | Show local preview error; save remains governed by existing save validation only. |
| `503 DB_NOT_READY` | Show schema-readiness warning; save remains allowed. |
| network/error | Show preview unavailable warning; save remains allowed. |

## Test Requirements For Runtime PR

The implementation PR must include tests that prove:

- warning preview calls the existing `/comprehensive-hours/preview` route
- request body uses `metric: 'planned'`
- warning/violation renders advisory copy
- save remains enabled after warning/violation
- original save function still runs after warning/violation
- preview errors do not block save
- no `allUsers` request body is emitted
- no new backend route, migration, or policy persistence is added

## Out Of Scope

- PR5 strong-control block-save guard
- stored comprehensive-hours policies
- scheduler role permissions
- all-users batch preview in save flows
- period summary/multitable snapshots
- advanced scheduling grid edit, copy/paste, import, temporary shift drawing
