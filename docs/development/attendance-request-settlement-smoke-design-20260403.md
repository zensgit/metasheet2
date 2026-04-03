# Attendance Request Settlement Smoke Design

## Context

Field verification already proved that approved attendance requests can transition correctly through the approval state machine, but debugging still depended on manually correlating:

- request create payload
- final approval action
- records query parameters

The existing `scripts/ops/attendance-smoke-api.mjs` script already covered request creation and approval, but it stopped before checking whether the resulting attendance record was visible via `/api/attendance/records`.

## Scope

- Extend the existing attendance smoke API script
- After request approval, query `/api/attendance/records` for the same `userId` and `workDate`
- Assert that:
  - a record is readable
  - the record status is `adjusted`

## Non-Goals

- No backend runtime changes
- No release packaging changes
- No new standalone smoke script

## Decision

Reuse the existing smoke path instead of adding a separate one-off repro tool. This keeps request approval and record settlement validation in the same script that already exercises the rest of the attendance API contract.

