# Attendance Self-Service Workbench Follow-up Design

## Context

The attendance self-service overview already has the first workbench slice: a status card, a request-status card, quick actions, and a status guide. The current product gap is not backend capability, but that the employee-facing workbench still needs stronger follow-up cues that make the next action obvious when there is an anomaly or a request backlog.

This slice stays strictly inside the attendance workbench. It does not touch approval-center routes or backend contracts.

## Decision

Turn the existing self-service cards into a clearer employee workbench by emphasizing follow-up guidance that is already derivable from current state:

1. When the current range has anomalies, the workbench should point employees toward the missing-punch flow first.
2. The request-status card should read like a backlog summary, not just a passive counter.
3. Quick actions must continue to prefill the request form without leaving overview mode.

## Changes

1. Extend the self-service dashboard regression coverage in `attendance-selfservice-dashboard.spec.ts` to lock down:
   - anomaly-driven follow-up guidance
   - request backlog detail and timing metadata
   - existing quick-action prefill behavior
2. Keep the design anchored to the existing self-service cards:
   - `My status`
   - `My request status`
   - `Quick actions`
   - `Status guide`

## Non-goals

- No changes to `AttendanceView.vue`.
- No approval-center ownership changes.
- No backend API or schema changes.
- No new attendance admin surface changes.
