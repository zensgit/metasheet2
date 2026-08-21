'use strict'

const { extractRequestedPunchOrgIdV1, loadActiveMembershipOrgIdsV1 } = require('./attendance-punch-org-resolution.cjs')

// SHADOW audit of the self-service punch route's org resolution
// (POST /api/attendance/punch only, plugins/plugin-attendance/index.cjs).
//
// This module never changes what org a punch is recorded under and never changes the
// response. It exists purely to answer, out of band, one question: if the route resolved
// org membership from the token CLAIM and the caller's `user_orgs` roster instead of (or in
// addition to) the request-supplied-org check that already ships
// (attendance-punch-org-resolution.cjs), would it have landed on the SAME org the route
// actually used? One audit row per punch, written to `attendance_org_resolution_shadow`
// (migration zzzz20260821090000_create_attendance_org_resolution_shadow.ts), never blocking
// or altering the punch itself.
//
// This module is wired into the route BEFORE `enforcePunchConstraints` (geofence/min-interval
// checks) and before any punch DML — a shadow row is written for every punch ATTEMPT that
// reaches this point in the route, not only for attempts that go on to succeed. A request that
// later 422s (e.g. WORK_DATE_ATTRIBUTION_AMBIGUOUS) or is rejected by the geofence check still
// gets one shadow row. There is no `punch_outcome` column distinguishing "attempted" from
// "actually recorded" — out of scope for a shadow-only audit — so a reader joining this table
// against `attendance_records` should expect more shadow rows than successful punches. There is
// also no retention/pruning policy yet for this table (owner item, not addressed by this PR).
//
// Env `ATTENDANCE_SELF_SERVICE_ORG_RESOLUTION_V1` (tri-state, parsed ONCE at plugin startup
// by `parseAttendanceOrgResolutionShadowModeV1` — see plugins/plugin-attendance/index.cjs's
// `activate()`):
//   - unset / 'off' (the default): completely inert. The route never calls into this module
//     at all on this posture — not "the module runs and no-ops", the CALL SITE itself is
//     gated, so there is exactly zero additional query and zero additional row on the hot
//     path. This is the byte-identical-when-off contract this line's other flags all keep.
//   - 'shadow': the ONLY implemented active mode. On POST /api/attendance/punch, AFTER the
//     route has already resolved (and, for a request-supplied org, membership-checked) the
//     org it is about to use, this module independently re-derives what a claim/membership
//     driven resolution would have picked and persists ONE comparison row. The insert is
//     wrapped in try/catch and any failure is logged at WARN (throttled — see
//     `throttledShadowWarn` below) and swallowed — never surfaced to the caller, never
//     blocking the punch (see `recordShadowOrgResolutionV1`).
//   - 'enforce' or any other value: NOT implemented here. Rather than silently falling back
//     to 'off' — a contract bug: an enum field must reject an unrecognised value, never
//     silently default — an unsupported value fails PLUGIN STARTUP closed
//     (`parseAttendanceOrgResolutionShadowModeV1` throws; `activate()` calls it early enough
//     that the throw takes the whole plugin down, not just this feature). 'enforce' semantics
//     are a future PR's work, not this one's.
//
// `org_claim` is `req.authenticatedTenantId` — NOT the raw, unverified JWT payload value.
// `AuthService.verifyToken` (packages/core-backend/src/auth/AuthService.ts) re-derives it PER
// REQUEST: the token's own `tenantId` claim is looked up against the caller's REAL active
// `user_orgs` membership (`AuthService.resolveSessionTenantId`) and only survives onto the
// returned user — and therefore onto `req.authenticatedTenantId`, which `jwt-middleware.ts`
// sets ONLY from that already-verified user (jwt-middleware.ts:101-103), BEFORE that same
// middleware lets an `x-tenant-id` header backfill `req.user.tenantId` for a token that carries
// no claim of its own — if the membership check passes. Reading `req.user.tenantId` here would
// additionally blur "the caller's membership-verified claim asserts org X" with "this one
// request's header said X", which is exactly the ambiguity a resolution audit needs to keep
// apart.
//
// `orgLegacy` (the `org_legacy` column) is supplied by the CALLER (the route, via
// `ctx.orgLegacy`) and is a fully opaque pass-through value as far as this module is concerned
// — it is never re-derived from `req` here, never defaulted, never validated. The route MUST
// pass the exact same value it is about to write the punch under (see the call site in
// `index.cjs`, right after `const orgId = punchOrgResolution.orgId`) — NOT a fresh call to the
// route's `getOrgId(req)` helper, which uses `??` on RAW (unnormalized) values and therefore
// diverges from the actually-resolved org whenever the request supplies an EMPTY-STRING
// `body.orgId` alongside a usable `x-org-id` header (`getOrgId` locks onto the empty string via
// `??` and never reaches the header; `extractRequestedPunchOrgIdV1`, which the route's actual
// resolution goes through, normalizes first and correctly falls through to the header). This is
// a call-site correctness property this module cannot verify from the inside — see the real-DB
// suite's dedicated case for the constructed proof.
//
// Values-free by construction on the failure path: the only thing ever logged when the insert
// fails is a Postgres error CODE (or 'UNKNOWN') — never the org ids, the user id, or the
// driver's own error message, none of which belong in a warn log for an audit table.

const DEFAULT_ORG_ID = 'default'

const SHADOW_MODE_OFF = 'off'
const SHADOW_MODE_SHADOW = 'shadow'

const SHADOW_RULE_REQUEST = 'request'
const SHADOW_RULE_CLAIM = 'claim'
const SHADOW_RULE_SOLE_NON_DEFAULT_MEMBERSHIP = 'sole_non_default_membership'
const SHADOW_RULE_LEGACY_DEFAULT = 'legacy_default'
const SHADOW_RULE_AMBIGUOUS = 'ambiguous'

/**
 * Enum-strict tri-state parser for `ATTENDANCE_SELF_SERVICE_ORG_RESOLUTION_V1`. Unset (or
 * blank) and `'off'` both mean the same inert default. `'shadow'` is the only implemented
 * active mode. Every other non-empty value — including the reserved, not-yet-implemented
 * `'enforce'` — throws rather than silently defaulting to `'off'`: a misconfigured enum
 * failing the deploy loudly is the point, not an inconvenience to work around.
 *
 * @param {string | undefined | null} rawValue
 * @returns {'off' | 'shadow'}
 */
function parseAttendanceOrgResolutionShadowModeV1(rawValue) {
  const trimmed = typeof rawValue === 'string' ? rawValue.trim() : ''
  if (trimmed.length === 0 || trimmed === SHADOW_MODE_OFF) return SHADOW_MODE_OFF
  if (trimmed === SHADOW_MODE_SHADOW) return SHADOW_MODE_SHADOW
  throw new Error(
    `ATTENDANCE_SELF_SERVICE_ORG_RESOLUTION_V1=${JSON.stringify(rawValue)} is not a supported value. `
      + `Use "off" (the default; omit the variable entirely for the same effect) or "shadow". `
      + `"enforce" is reserved for a future PR and is NOT implemented by this build; any other `
      + `value is rejected the same way — the plugin fails to activate rather than silently `
      + `falling back to "off".`,
  )
}

/**
 * Pure decision core. Takes already-extracted, already-normalized data — no Express req/res,
 * no DB — so every branch is unit-testable in isolation. Mirrors the shape of
 * `decidePunchOrgResolutionV1` in the sibling module: a plain object in, a plain object out.
 *
 * Rule order (first match wins):
 *   1. `request`                      — the request itself supplied an org (already
 *                                        membership-checked upstream by
 *                                        attendance-punch-org-resolution.cjs); the org the
 *                                        route actually used (`orgLegacy`) IS that org, so this
 *                                        module's guess is simply that same value.
 *   2. `claim`                        — no request-supplied org, but the token carries a
 *                                        tenant CLAIM, and either that claim is not the
 *                                        legacy default sentinel OR the caller has no
 *                                        non-default membership to prefer instead. This is the
 *                                        ONLY branch that trusts the claim outright.
 *   3. `sole_non_default_membership`  — no usable claim (see 2's guard below), but the caller
 *                                        has EXACTLY ONE non-default active membership: an
 *                                        unambiguous single alternative to the legacy default.
 *   4. `legacy_default`               — no usable claim, and the caller has ZERO non-default
 *                                        memberships at all: 'default' is the only membership
 *                                        that could possibly apply.
 *   5. `ambiguous`                    — none of the above: either the claim IS the legacy
 *                                        default sentinel while the caller ALSO holds one or
 *                                        more non-default memberships (the claim is refused as
 *                                        a false-positive default — see rule 2's guard), or the
 *                                        caller holds two-or-more non-default memberships with
 *                                        no claim and no request to break the tie. `orgChosen`
 *                                        is `null`: refusing to guess is the honest answer, not
 *                                        picking one arbitrarily.
 *
 * Rule 2's guard is the load-bearing branch this whole audit exists to surface: a token claim
 * of exactly `'default'` — the shape a pre-existing/backfilled user's token carries when no
 * tenant was ever chosen — must NOT be trusted as "the caller's real org" the moment that same
 * caller also holds a real, non-default membership. Trusting it there would silently prefer a
 * placeholder value over an actual membership; refusing it here is deliberate, not an omission.
 *
 * `orgLegacy` is used ONLY as a plain equality target for `agree` (and, verbatim, as
 * `orgChosen` under rule `request`) — this function never re-derives, defaults, or validates
 * it. Whatever the caller passes in is what gets echoed back; correctness of that value is
 * entirely the caller's responsibility (see the module doc comment above).
 *
 * @param {{
 *   requestOrgSupplied: boolean,
 *   orgLegacy: string,
 *   orgClaim: string | null,
 *   activeMembershipOrgIds: string[],
 * }} input
 * @returns {{
 *   membershipCount: number,
 *   nonDefaultMembershipCount: number,
 *   orgChosen: string | null,
 *   agree: boolean,
 *   rule: 'request' | 'claim' | 'sole_non_default_membership' | 'legacy_default' | 'ambiguous',
 * }}
 */
function decideShadowOrgResolutionV1(input) {
  const requestOrgSupplied = input && input.requestOrgSupplied === true
  const orgLegacy = input && typeof input.orgLegacy === 'string' ? input.orgLegacy : ''
  const orgClaim = input && typeof input.orgClaim === 'string' && input.orgClaim.length > 0 ? input.orgClaim : null
  const activeMembershipOrgIds = input && Array.isArray(input.activeMembershipOrgIds) ? input.activeMembershipOrgIds : []

  const membershipCount = activeMembershipOrgIds.length
  const nonDefaultMemberships = activeMembershipOrgIds.filter((orgId) => orgId !== DEFAULT_ORG_ID)
  const nonDefaultMembershipCount = nonDefaultMemberships.length

  let orgChosen = null
  let rule = SHADOW_RULE_AMBIGUOUS

  if (requestOrgSupplied) {
    orgChosen = orgLegacy
    rule = SHADOW_RULE_REQUEST
  } else if (orgClaim !== null && (orgClaim !== DEFAULT_ORG_ID || nonDefaultMembershipCount === 0)) {
    orgChosen = orgClaim
    rule = SHADOW_RULE_CLAIM
  } else if (nonDefaultMembershipCount === 1) {
    orgChosen = nonDefaultMemberships[0]
    rule = SHADOW_RULE_SOLE_NON_DEFAULT_MEMBERSHIP
  } else if (nonDefaultMembershipCount === 0) {
    orgChosen = DEFAULT_ORG_ID
    rule = SHADOW_RULE_LEGACY_DEFAULT
  } else {
    orgChosen = null
    rule = SHADOW_RULE_AMBIGUOUS
  }

  return {
    membershipCount,
    nonDefaultMembershipCount,
    orgChosen,
    agree: orgChosen === orgLegacy,
    rule,
  }
}

// Warn-log throttling: at most one warn per process per WARN_THROTTLE_WINDOW_MS, regardless of
// how many recordShadowOrgResolutionV1 failures happen in that window. This is a
// non-fatal/best-effort audit write on a hot path (every punch, when the flag is on) — a
// sustained failure (e.g. the table dropped, or a connection-pool outage) must not turn into a
// warn-per-punch log storm. `lastWarnAtMs` is module-level (shared across every call in this
// process), matching "once per process", not once per request/user/table.
const WARN_THROTTLE_WINDOW_MS = 60_000
let lastWarnAtMs = 0

function resolveWarnFn(logger) {
  return logger && typeof logger.warn === 'function'
    ? logger.warn.bind(logger)
    : typeof console !== 'undefined' && typeof console.warn === 'function'
      ? console.warn.bind(console)
      : () => {}
}

function throttledShadowWarn(logger, message, meta) {
  const now = Date.now()
  if (now - lastWarnAtMs < WARN_THROTTLE_WINDOW_MS) return
  lastWarnAtMs = now
  resolveWarnFn(logger)(message, meta)
}

/**
 * Test-only: resets the module-level warn-throttle clock so a test suite can assert throttling
 * behaviour deterministically regardless of what ran (and warned) earlier in the same process.
 * Never called from production code.
 */
function resetShadowWarnThrottleForTestingV1() {
  lastWarnAtMs = 0
}

/**
 * Route-level orchestration: loads the caller's active memberships (ONE query — the same
 * `user_orgs` predicate the sibling punch-org-resolution module already uses, reused here
 * rather than re-implemented), runs the pure core, and inserts ONE audit row. Non-fatal by
 * construction — any failure (missing table, connection error, constraint violation) is caught,
 * logged at WARN, throttled (`throttledShadowWarn`) with only a Postgres error code (never the
 * org ids, never `err.message`), and swallowed. The punch this is called from must never fail,
 * slow down its response shape, or change its resolved org because of this function.
 *
 * Callers MUST gate the call itself on `parseAttendanceOrgResolutionShadowModeV1(...) ===
 * 'shadow'` — this function does not re-check the env itself, so the 'off' posture's
 * zero-queries guarantee depends entirely on the call site never invoking it, not on an
 * internal early-return.
 *
 * @param {{ query: (sql: string, params?: unknown[]) => Promise<unknown[]> }} db
 * @param {object} req - Express request (`.user`, `.body`, `.query`, `.headers`,
 *   `.authenticatedTenantId`)
 * @param {{ userId: string, orgLegacy: string, route: string }} ctx - `userId` is the SAME
 *   value the route already derived via `getUserId(req)` for its own 401 check, passed in
 *   rather than re-extracted here so there is exactly one source of caller identity per
 *   request. `orgLegacy` is the org the route is actually about to use (post membership-check)
 *   — see the module doc comment for the exact call-site correctness requirement on this value.
 *   `route` is the route's own literal path, not `req.path` — this module is wired into ONE
 *   route only, and a literal keeps this row honest even if the route is ever remounted.
 * @param {{ warn: (message: string, meta?: Record<string, unknown>) => void }} [logger]
 * @returns {Promise<void>}
 */
async function recordShadowOrgResolutionV1(db, req, ctx, logger) {
  try {
    const userId = ctx && typeof ctx.userId === 'string' && ctx.userId.length > 0 ? ctx.userId : null
    if (userId === null) {
      // attendance_org_resolution_shadow.user_id is NOT NULL. The route always supplies a
      // non-empty ctx.userId here — the SAME value already required non-null by the route's
      // own pre-existing 401 check (getUserId(req)) before this is ever reached — so this
      // branch should be unreachable in production. Skip the otherwise-guaranteed-to-fail
      // INSERT rather than issue a query that can only violate the NOT NULL constraint, and
      // warn (throttled, like every other failure path here) instead of staying silent.
      throttledShadowWarn(logger, 'attendance_org_resolution_shadow skipped: missing userId', {})
      return
    }

    const orgLegacy = ctx && typeof ctx.orgLegacy === 'string' ? ctx.orgLegacy : ''
    const route = ctx && typeof ctx.route === 'string' ? ctx.route : ''

    const requestedOrgId = extractRequestedPunchOrgIdV1(req)
    const requestOrgSupplied = requestedOrgId !== null
    const rawClaim = req && req.authenticatedTenantId
    const orgClaim = typeof rawClaim === 'string' && rawClaim.trim().length > 0 ? rawClaim.trim() : null

    const activeMembershipOrgIds = await loadActiveMembershipOrgIdsV1(db, userId)

    const decision = decideShadowOrgResolutionV1({
      requestOrgSupplied,
      orgLegacy,
      orgClaim,
      activeMembershipOrgIds,
    })

    await db.query(
      `INSERT INTO attendance_org_resolution_shadow
         (user_id, route, org_legacy, org_claim, request_org_supplied, membership_count,
          non_default_membership_count, org_chosen, agree, rule)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        userId,
        route,
        orgLegacy,
        orgClaim,
        requestOrgSupplied,
        decision.membershipCount,
        decision.nonDefaultMembershipCount,
        decision.orgChosen,
        decision.agree,
        decision.rule,
      ],
    )
  } catch (err) {
    const code = err && typeof err === 'object' && typeof err.code === 'string' ? err.code : 'UNKNOWN'
    throttledShadowWarn(logger, 'attendance_org_resolution_shadow insert failed; non-fatal, punch response unaffected', { code })
  }
}

module.exports = {
  parseAttendanceOrgResolutionShadowModeV1,
  decideShadowOrgResolutionV1,
  recordShadowOrgResolutionV1,
  resetShadowWarnThrottleForTestingV1,
  WARN_THROTTLE_WINDOW_MS,
  SHADOW_MODE_OFF,
  SHADOW_MODE_SHADOW,
  SHADOW_RULE_REQUEST,
  SHADOW_RULE_CLAIM,
  SHADOW_RULE_SOLE_NON_DEFAULT_MEMBERSHIP,
  SHADOW_RULE_LEGACY_DEFAULT,
  SHADOW_RULE_AMBIGUOUS,
}
