/**
 * SR-1 self-service contract mirror for `GET /api/attendance/rules/me` (#5012).
 *
 * The server REJECTS subject-override headers on PRESENCE
 * (`ATTENDANCE_RULES_ME_FORBIDDEN_HEADER_KEYS`, plugins/plugin-attendance/index.cjs) —
 * deliberately, never silently ignoring them — while the web app's `authHeaders()`
 * injects `x-tenant-id` globally. Every rules/me call must therefore omit EXACTLY this
 * set. ONE exported constant so the call site and the specs share a single copy; the
 * required-lane fixture-sync spec (attendance-selfservice-dashboard.spec.ts) compares
 * this array against the server source itself, so an 8th server key reds CI here
 * instead of silently re-opening the 400 banner for that hint type.
 *
 * Scope note: this mirrors the HEADER half of the server contract only. The server
 * additionally rejects subject-override keys in query/body
 * (ATTENDANCE_RULES_ME_FORBIDDEN_QUERY_KEYS) — the single call site sends neither,
 * so there is nothing to omit on that half.
 */
export const ATTENDANCE_RULES_ME_OMIT_HEADERS: readonly string[] = Object.freeze([
  'x-user-id',
  'x-org-id',
  'x-tenant-id',
  'x-workspace-id',
  'x-group-id',
  'x-attendance-group-id',
  'x-schedule-group-id',
])
