'use strict'

// Membership-derived org resolution for POST /api/attendance/punch (self-service route).
//
// The route's org selection previously ran through the plugin-wide `getOrgId(req)` helper
// (plugins/plugin-attendance/index.cjs) for every request shape. `getOrgId` stays exactly
// as-is for every route, including this one when the request names no org — many routes
// depend on its current behavior, and org resolution for an unscoped punch is a separate,
// unresolved design question, out of scope here. This module adds a punch-specific check
// used ONLY by POST /api/attendance/punch, applied before any rule loading / W7 mirror /
// write-boundary call so both the legacy and W4 legs inherit its result.
//
// The rule: if the request supplies an org (body.orgId / query.orgId / x-org-id — the same
// three sources `getOrgId` reads, same per-value normalization: non-empty trimmed string or
// a finite number coerced to string), it MUST be one of the caller's active `user_orgs`
// memberships (`SELECT org_id FROM user_orgs WHERE user_id = $1 AND is_active = true` — the
// same predicate shape as packages/core-backend/src/attendance/w4c0-authorization.ts's
// `requireActiveMembership`, there scoped to one org via an extra `AND org_id = $2`; here
// scoped to all of the caller's orgs since this check has to test one caller-named value
// against the roster), or the request is refused with 403 ATTENDANCE_PUNCH_ORG_NOT_PERMITTED
// before any DML. There is no admin waiver on this self-service route, and the comparison is
// exact-string (case-sensitive, matching `user_orgs.org_id`'s `text` column type — a
// case-differing twin of a real membership is not treated as a match).
//
// When the request supplies no org, this module does not participate at all: the route falls
// straight back to whatever `getOrgId(req)` already resolves (passed in as `legacyOrgId`),
// with no membership query on that path.
//
// Kept mostly as pure/testable pieces: `decidePunchOrgResolutionV1` takes plain data (no
// Express req/res, no DB) so the branch logic is unit-testable without a database;
// `resolvePunchOrgIdV1` is the thin async orchestration that loads memberships (only when a
// membership check is actually needed) and applies it. Values-free by construction: the only
// identifiers this ever surfaces (in its return shape or in the route's error response) are
// org ids already present on the request or already members of the caller's own roster —
// never a fabricated or echoed-back value beyond what the caller supplied.

function normalizeOrgIdentifierV1(value) {
  if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return null
}

/**
 * The org selector sources this route accepts as a caller-supplied request — deliberately
 * NARROWER than `getOrgId`'s full precedence chain: `user.orgId` / `user.workspaceId` are
 * session-derived, not something the request "supplies", so they are never treated as a
 * selector to permission-check here.
 *
 * @param {{ body?: Record<string, unknown> | null, query?: Record<string, unknown> | null, headers?: Record<string, unknown> | null }} req
 * @returns {string | null}
 */
function extractRequestedPunchOrgIdV1(req) {
  const headerOrg = req?.headers?.['x-org-id']
  const header = Array.isArray(headerOrg) ? headerOrg[0] : headerOrg
  return (
    normalizeOrgIdentifierV1(req?.body?.orgId)
    ?? normalizeOrgIdentifierV1(req?.query?.orgId)
    ?? normalizeOrgIdentifierV1(header)
  )
}

/**
 * Mirrors `getUserId`'s own precedence (user.id ?? user.sub ?? user.userId ?? x-user-id
 * header) so the membership lookup below uses the SAME caller identity the route's own
 * pre-existing 401 check already established.
 *
 * @param {{ user?: { id?: unknown, sub?: unknown, userId?: unknown } | null, headers?: Record<string, unknown> | null }} req
 * @returns {string | null}
 */
function extractPunchCallerUserIdV1(req) {
  const user = req?.user
  const headerUserId = req?.headers?.['x-user-id']
  const header = Array.isArray(headerUserId) ? headerUserId[0] : headerUserId
  const raw = user?.id ?? user?.sub ?? user?.userId ?? header
  return normalizeOrgIdentifierV1(raw)
}

/**
 * Pure decision core for the requested-org case above. Takes already-extracted,
 * already-normalized data — no Express req/res, no DB — so it is unit-testable in isolation.
 * Only called when the request actually supplied an org; the no-org case never reaches this
 * (see `resolvePunchOrgIdV1`).
 *
 * Exact string comparison against the membership set — deliberately not case-insensitive,
 * not trimmed-and-compared, not normalized in any way beyond what `normalizeOrgIdentifierV1`
 * already did to both sides independently before this function ever sees them.
 *
 * @param {{ requestedOrgId: string, activeMembershipOrgIds: string[] }} input
 * @returns
 *   | { ok: true, orgId: string }
 *   | { ok: false, status: 403, code: 'ATTENDANCE_PUNCH_ORG_NOT_PERMITTED' }
 */
function decidePunchOrgResolutionV1(input) {
  const requestedOrgId = input && typeof input.requestedOrgId === 'string' ? input.requestedOrgId : null
  const memberships = Array.isArray(input && input.activeMembershipOrgIds) ? input.activeMembershipOrgIds : []

  if (requestedOrgId !== null && memberships.includes(requestedOrgId)) {
    return { ok: true, orgId: requestedOrgId }
  }
  return { ok: false, status: 403, code: 'ATTENDANCE_PUNCH_ORG_NOT_PERMITTED' }
}

/**
 * @param {{ query: (sql: string, params?: unknown[]) => Promise<Array<{ org_id: string }>> }} db
 * @param {string} userId
 * @returns {Promise<string[]>}
 */
async function loadActiveMembershipOrgIdsV1(db, userId) {
  const rows = await db.query(
    'SELECT org_id FROM user_orgs WHERE user_id = $1 AND is_active = true',
    [userId],
  )
  return rows
    .map((row) => (row ? row.org_id : null))
    .filter((orgId) => typeof orgId === 'string' && orgId.length > 0)
}

/**
 * Punch-route org check. Used ONLY by POST /api/attendance/punch — every other route keeps
 * calling `getOrgId(req)` unchanged, and so does this route whenever the request names no
 * org at all.
 *
 * @param {{ query: (sql: string, params?: unknown[]) => Promise<unknown[]> }} db
 * @param {object} req - Express request (or an equivalent shape: `.user`, `.body`, `.query`, `.headers`)
 * @param {string} legacyOrgId - the value `getOrgId(req)` already resolves for this request;
 *   returned verbatim whenever the request supplies no org, so this module never re-derives
 *   `getOrgId`'s own precedence chain and cannot drift from it. On that path no membership
 *   query runs at all (nothing to check the caller's identity against).
 * @returns {Promise<
 *   | { ok: true, orgId: string }
 *   | { ok: false, status: 403, code: 'ATTENDANCE_PUNCH_ORG_NOT_PERMITTED' }
 * >}
 */
async function resolvePunchOrgIdV1(db, req, legacyOrgId) {
  const requestedOrgId = extractRequestedPunchOrgIdV1(req)
  if (requestedOrgId === null) {
    return { ok: true, orgId: legacyOrgId }
  }
  const userId = extractPunchCallerUserIdV1(req)
  const activeMembershipOrgIds = userId ? await loadActiveMembershipOrgIdsV1(db, userId) : []
  return decidePunchOrgResolutionV1({ requestedOrgId, activeMembershipOrgIds })
}

module.exports = {
  resolvePunchOrgIdV1,
  decidePunchOrgResolutionV1,
  extractRequestedPunchOrgIdV1,
  extractPunchCallerUserIdV1,
  loadActiveMembershipOrgIdsV1,
  normalizeOrgIdentifierV1,
}
