'use strict'

// Membership-derived org resolution for POST /api/attendance/punch (self-service route).
//
// The route's org selection previously ran through the plugin-wide `getOrgId(req)` helper
// (plugins/plugin-attendance/index.cjs), whose precedence is
// `body.orgId ?? query.orgId ?? user.orgId ?? user.workspaceId ?? x-org-id ?? DEFAULT_ORG_ID`.
// That helper trusts any caller-supplied org selector at face value — it never checks the
// selector against the caller's actual memberships. `getOrgId` stays exactly as-is for every
// OTHER route (many depend on its current behavior); this module adds a punch-specific
// resolver used ONLY by POST /api/attendance/punch, applied before any rule loading / W7
// mirror / write-boundary call so both the legacy and W4 legs inherit the resolved org.
//
// Rules (applied in this order):
//   1. Load the caller's active memberships:
//      `SELECT org_id FROM user_orgs WHERE user_id = $1 AND is_active = true` — the same
//      predicate shape as packages/core-backend/src/attendance/w4c0-authorization.ts's
//      `requireActiveMembership` (there scoped to one org via an extra `AND org_id = $2`;
//      here scoped to all of the caller's orgs since the route must choose one for the
//      caller, not confirm one already chosen elsewhere).
//   2. If the request supplies an org (body.orgId / query.orgId / x-org-id — the same three
//      sources `getOrgId` reads, same per-value normalization: non-empty trimmed string or a
//      finite number coerced to string), it MUST be one of the memberships from step 1, or
//      this returns ATTENDANCE_PUNCH_ORG_NOT_PERMITTED (403) before any DML. There is no
//      admin waiver on this self-service route.
//   3. If the request supplies no org: exactly one active membership resolves to that org;
//      more than one is ATTENDANCE_PUNCH_ORG_REQUIRED (400, the caller must disambiguate);
//      zero active memberships is a residual fallback — the caller substitutes the org
//      `getOrgId(req)` already resolves today (single-tenant callers with no `user_orgs` row
//      keep today's behavior byte-identical; see `resolvePunchOrgIdV1`'s `legacyOrgId` param).
//
// Kept mostly as pure/testable pieces: `decidePunchOrgResolutionV1` takes plain data (no
// Express req/res, no DB) so the branch logic in rules 2-3 is unit-testable without a
// database; `resolvePunchOrgIdV1` is the thin async orchestration that loads memberships and
// applies it. Values-free by construction: the only identifiers this ever surfaces (in its
// return shape or in the route's error response) are org ids already present on the request
// or already members of the caller's own roster — never a fabricated or echoed-back value
// beyond what the caller supplied.

function normalizeOrgIdentifierV1(value) {
  if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return null
}

/**
 * The org selector sources this route accepts as a caller-supplied request — deliberately
 * NARROWER than `getOrgId`'s full precedence chain: `user.orgId` / `user.workspaceId` are
 * session-derived, not something the request "supplies", so they are never treated as a
 * selector to permission-check here (the zero-membership fallback still reaches them via
 * `getOrgId`, unchanged, in rule 3).
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
 * Pure decision core for rules 2-3 above. Takes already-extracted, already-normalized data —
 * no Express req/res, no DB — so it is unit-testable in isolation.
 *
 * @param {{ requestedOrgId: string | null, activeMembershipOrgIds: string[] }} input
 * @returns
 *   | { ok: true, orgId: string }
 *   | { ok: true, orgId: null, fallbackToLegacy: true }
 *   | { ok: false, status: 403, code: 'ATTENDANCE_PUNCH_ORG_NOT_PERMITTED' }
 *   | { ok: false, status: 400, code: 'ATTENDANCE_PUNCH_ORG_REQUIRED' }
 */
function decidePunchOrgResolutionV1(input) {
  const requestedOrgId = input && typeof input.requestedOrgId === 'string' ? input.requestedOrgId : null
  const memberships = Array.isArray(input && input.activeMembershipOrgIds) ? input.activeMembershipOrgIds : []

  if (requestedOrgId !== null) {
    if (memberships.includes(requestedOrgId)) {
      return { ok: true, orgId: requestedOrgId }
    }
    return { ok: false, status: 403, code: 'ATTENDANCE_PUNCH_ORG_NOT_PERMITTED' }
  }

  if (memberships.length === 0) {
    return { ok: true, orgId: null, fallbackToLegacy: true }
  }
  if (memberships.length === 1) {
    return { ok: true, orgId: memberships[0] }
  }
  return { ok: false, status: 400, code: 'ATTENDANCE_PUNCH_ORG_REQUIRED' }
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
 * Punch-route org resolver. Used ONLY by POST /api/attendance/punch — every other route keeps
 * calling `getOrgId(req)` unchanged.
 *
 * @param {{ query: (sql: string, params?: unknown[]) => Promise<unknown[]> }} db
 * @param {object} req - Express request (or an equivalent shape: `.user`, `.body`, `.query`, `.headers`)
 * @param {string} legacyOrgId - the value `getOrgId(req)` already resolves for this request;
 *   used ONLY on the zero-membership fallback leg (rule 3), so the resolver never re-derives
 *   `getOrgId`'s own precedence chain and cannot drift from it.
 * @returns {Promise<
 *   | { ok: true, orgId: string }
 *   | { ok: false, status: 403, code: 'ATTENDANCE_PUNCH_ORG_NOT_PERMITTED' }
 *   | { ok: false, status: 400, code: 'ATTENDANCE_PUNCH_ORG_REQUIRED' }
 * >}
 */
async function resolvePunchOrgIdV1(db, req, legacyOrgId) {
  const userId = extractPunchCallerUserIdV1(req)
  const requestedOrgId = extractRequestedPunchOrgIdV1(req)
  const activeMembershipOrgIds = userId ? await loadActiveMembershipOrgIdsV1(db, userId) : []

  const decision = decidePunchOrgResolutionV1({ requestedOrgId, activeMembershipOrgIds })
  if (!decision.ok) return decision
  if (decision.fallbackToLegacy) {
    return { ok: true, orgId: legacyOrgId }
  }
  return { ok: true, orgId: decision.orgId }
}

module.exports = {
  resolvePunchOrgIdV1,
  decidePunchOrgResolutionV1,
  extractRequestedPunchOrgIdV1,
  extractPunchCallerUserIdV1,
  loadActiveMembershipOrgIdsV1,
  normalizeOrgIdentifierV1,
}
