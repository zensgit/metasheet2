'use strict'

// #4709 FSER-4 prerequisite (contract amendment `docs/development/
// attendance-4709-fser4-member-projection-contract-amendment-20260804.md` §2,
// RATIFIED `45d71c4209af35a63768ce7ce9f576377f6b8ce4`, OD-4709-2=(a)):
// GET /api/attendance/groups/:groupId/fixed-schedule/effectiveness/me is a
// member-safe self-service read. Its identity resolution is deliberately
// narrower than the admin FSER route's `resolveAttendanceFixedScheduleRouteActorContext`
// (plugins/plugin-attendance/index.cjs) — that resolver folds a body/query/header
// org mismatch into one 403. The contract instead requires THREE distinct
// postures for this route, in this order:
//   1. no authenticated user            -> 401 (unchanged)
//   2. no authenticated org             -> 403, values-free, before any SQL
//   3. a body/query `userId` or `orgId` selector, present at all -> 400
//      (this route never accepts a caller-supplied subject/org selector —
//      not even a byte-equal one; only the authenticated principal may name
//      the subject/org)
//   4. an `x-user-id`/`x-org-id` header that mismatches the authenticated
//      principal -> 403; a header that is byte-equal is tolerated (existing
//      bearer/dev-token clients that always echo the header keep working)
//      but is NEVER used as an identity source — the returned identity is
//      always the authenticated principal, never the header value.
//
// Kept as a pure function (no Express req/res) so it is unit-testable without
// mocking HTTP, per this line's "no fake switch tests" discipline — every
// negative leg here has a corresponding exact-shape unit test in
// packages/core-backend/tests/unit/attendance-fixed-schedule-self-route-identity.test.ts.
// That file proves ONLY this resolver's own logic in isolation. It does NOT
// prove that the route (plugins/plugin-attendance/index.cjs) actually calls
// this function or obeys its verdict — a route that dropped the
// `if (!identity.ok)` check, or called this resolver but ignored the result,
// would still pass every test in that file untouched. That separate,
// route-level claim is proven by the harness-based probes in
// packages/core-backend/tests/unit/attendance-fixed-schedule-self-route-wiring.test.ts,
// which invoke the real route handler end to end (not this function
// directly) and assert both the HTTP outcome and that no SQL is reached on
// every rejection leg.

function flattenSelectorValues(value) {
  if (value === undefined || value === null) return []
  return Array.isArray(value) ? value.filter(item => item !== undefined && item !== null) : [value]
}

function hasSelector(value) {
  return flattenSelectorValues(value).length > 0
}

/**
 * @param {{
 *   authenticatedUserId: string | null,
 *   authenticatedOrgId: string | null,
 *   body: Record<string, unknown> | null | undefined,
 *   query: Record<string, unknown> | null | undefined,
 *   headers: Record<string, unknown> | null | undefined,
 * }} input
 * @returns {{ ok: true, userId: string, orgId: string } | { ok: false, status: number, code: string, message: string }}
 */
function resolveAttendanceFixedScheduleSelfRouteIdentity(input) {
  const { authenticatedUserId, authenticatedOrgId, body, query, headers } = input

  if (!authenticatedUserId) {
    return { ok: false, status: 401, code: 'UNAUTHORIZED', message: 'User ID not found' }
  }
  if (!authenticatedOrgId) {
    return { ok: false, status: 403, code: 'FORBIDDEN', message: 'Authenticated organization not found' }
  }

  const forbiddenSelectorPresent = hasSelector(body?.userId)
    || hasSelector(body?.orgId)
    || hasSelector(query?.userId)
    || hasSelector(query?.orgId)
  if (forbiddenSelectorPresent) {
    return {
      ok: false,
      status: 400,
      code: 'VALIDATION_ERROR',
      message: 'userId and orgId are not accepted on this route; the authenticated principal is the only identity source',
    }
  }

  const headerUserIdValues = flattenSelectorValues(headers?.['x-user-id'])
  const headerOrgIdValues = flattenSelectorValues(headers?.['x-org-id'])
  const headerMismatch = headerUserIdValues.some(value => value !== authenticatedUserId)
    || headerOrgIdValues.some(value => value !== authenticatedOrgId)
  if (headerMismatch) {
    return { ok: false, status: 403, code: 'FORBIDDEN', message: 'Insufficient permissions' }
  }

  return { ok: true, userId: authenticatedUserId, orgId: authenticatedOrgId }
}

module.exports = { resolveAttendanceFixedScheduleSelfRouteIdentity }
