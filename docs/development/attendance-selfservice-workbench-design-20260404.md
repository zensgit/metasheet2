# Attendance Self-Service Workbench Design

## Context

The attendance self-service overview already has the first workbench slice: a status card, a request-status card, quick actions, and a status guide. The next gap is not backend capability, but that the employee-facing workbench still reads like a set of passive cards instead of an actual “next action” cockpit.

This slice stays strictly inside the attendance workbench. It does not touch approval-center routes or backend contracts.

## Decision

Turn the existing self-service cards into a clearer employee workbench by emphasizing follow-up guidance that is already derivable from current state:

1. When the current range has anomalies, the workbench should point employees toward the missing-punch flow first.
2. The request-status card should read like a backlog summary with a highlighted follow-up, not just a passive counter.
3. The quick-actions card should expose a recommended next step before the generic action buttons.
4. Existing quick actions must continue to prefill the request form without leaving overview mode.

## Changes

1. Update `AttendanceView.vue` so the self-service area gains:
   - a focus list under `My status`
   - a request follow-up callout under `My request status`
   - a recommended next-step callout in `Quick actions`
   - request status explanation copy for recent requests
2. Extend `attendance-selfservice-dashboard.spec.ts` to lock down:
   - anomaly-driven follow-up guidance
   - request follow-up and explanation copy
   - recommended action visibility
   - existing quick-action prefill behavior
3. Keep the design anchored to the existing self-service cards:
   - `My status`
   - `My request status`
   - `Quick actions`
   - `Status guide`

## Non-goals

- No approval-center ownership changes.
- No backend API or schema changes.
- No new attendance admin surface changes.
