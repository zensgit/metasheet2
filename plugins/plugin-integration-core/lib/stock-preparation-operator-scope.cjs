'use strict'

// THE OPERATOR VALUE SCOPE — the plugin's answer to "may THIS end user see this?"
//
// ---------------------------------------------------------------------------
// WHY THIS MODULE EXISTS
// ---------------------------------------------------------------------------
//
// Until now this plugin could answer exactly one question about a caller: "may this principal CALL
// this route" (`requireAccess` -> `hasPermission` -> `satisfiesStockPrepAccess`). It could not answer
// "is this data THEIRS", because every read runs through `getMultitableRecordsApi()` — a service-
// account facade with `actorId` null throughout — and the plugin's permission domain
// (`integration:*` / `stock-prep:*`) is deliberately separate from multitable's ACL domain.
//
// That was survivable while every stock-prep read was VALUES-FREE: a handle, a closed enum and a
// count are the same three things whoever is looking. It stops being survivable the moment an
// operator surface carries the customer's own business VALUES, because then "who is looking" is
// exactly the question that decides whether the response is the job or a leak.
//
// ---------------------------------------------------------------------------
// THE BOUNDARY THIS ENCODES: "whose data is it", not "which screen is it"
// ---------------------------------------------------------------------------
//
// The values-free posture exists to stop the PLATFORM/CONSULTANT side seeing customer values (see
// `stock-preparation-project-reads.cjs`'s header, and the OD-E3 row in
// docs/development/real-external-integration-line-design-lock-20260712.md). A factory operator
// seeing their OWN tenant's project numbers and names is not that leak — it is their job.
//
// So the rule this module enforces is not "values are forbidden here". It is:
//
//   A VALUE-BEARING READ MAY ONLY EVER RETURN THE CALLER'S OWN TENANT'S DATA,
//   AND A PRINCIPAL WITH NO TENANT OF ITS OWN THEREFORE HAS NOTHING IT MAY SEE.
//
// The second clause is the load-bearing half, and it is what keeps the platform side out. Note what
// `resolveTenantId` in http-routes.cjs does — correctly, for a values-free read:
//
//     // Tenant-bound principals stay confined to their authenticated tenant, including tenant
//     // admins. Only a tenantless platform admin retains the existing explicit cross-tenant read
//     // capability.
//
// A tenantless platform admin — us, the consultant, the support engineer — may steer `tenantId` from
// the request and read ANY tenant. That is precisely the cross-tenant capability the values-free
// posture was built to render harmless. A value-bearing read must therefore NOT be derived through
// `resolveTenantId`. It is derived here instead, where a tenantless principal is refused outright:
// they have no own tenant, so under "whose data is it" there is no data that is theirs.
//
// The effect, stated plainly, is the owner's ruling made mechanical:
//   * platform/admin-facing surfaces keep `resolveTenantId` and stay values-free — unchanged;
//   * EVERY tenant-scoped OPERATOR surface that carries values uses THIS, and is unreachable by a
//     tenantless platform admin (403 OPERATOR_SCOPE_TENANT_REQUIRED) and by any cross-tenant
//     steering or header-spoofing attempt (403).
//
// "EVERY" is literal, and it is the whole set — there are exactly three value-bearing stock-prep
// reads and all three resolve their tenant here:
//   1. GET …/confirmation-decisions/value-entry  the per-decision readback  (O1')
//   2. GET …/prep-lines/export                   the materials workbook     (按项目导出物料 Excel)
//   3. GET …/operator/projects                   the project directory      (一线看得见自己工厂的项目)
// (1) and (2) predate this module and were left on `resolveTenantId` when it landed, which was a
// live cross-tenant leak on a claimless deployment rather than a stylistic gap — see the routes.
// A FOURTH value-bearing read must join this list, not invent a fourth way to decide tenancy.
//
// ---------------------------------------------------------------------------
// WHAT THIS CAPABILITY DOES **NOT** GRANT
// ---------------------------------------------------------------------------
//
// Stated here, not only in the PR body, because the next person to reuse it will read this file:
//
//   * It does NOT weaken, replace, consult or re-implement multitable's ACL domain. The underlying
//     read still runs on the service-account records API with the plugin's own authority. This
//     module narrows WHICH TENANT'S staging project that authority is pointed at; it does not make
//     the records service user-aware, and it grants no sheet-, row- or field-level authorization.
//   * It does NOT grant any permission. A caller who fails `stock-prep:operate` is already refused by
//     `requireAccess` before this module is reached; a caller who passes it still gets nothing here
//     unless they have a tenant of their own.
//   * It does NOT authorize a WRITE. It resolves a READ scope only. Writes keep
//     `resolveAuthenticatedWriteTenantId` and their own audit discipline.
//   * It does NOT make the resulting response values-free-exempt in the AUDIT. `actorId` is a
//     principal handle, `tenantId` is a tenant handle; neither is a customer business value, and
//     nothing else from this module may reach an audit row.
//   * It is NOT per-row. It answers "which tenant's data may this principal be shown", once, before
//     any IO. Per-row lineage and per-row value panels are a strictly later question that this scope
//     is the necessary precondition for, not an answer to.
//
// ---------------------------------------------------------------------------
// THE HOST SEAM, AND WHY IT IS NOT OPTIONAL
// ---------------------------------------------------------------------------
//
// `req.user.tenantId` IS NOT ALWAYS A VERIFIED CLAIM. The host's auth middleware
// (packages/core-backend/src/auth/jwt-middleware.ts, hydrateAuthenticatedUser) does this:
//
//     const authenticatedTenantId = typeof user.tenantId === 'string' ? user.tenantId.trim() : ''
//     if (authenticatedTenantId) { req.authenticatedTenantId = authenticatedTenantId }
//     const headerTenantId = extractTenantFromHeaders(req.headers)
//     if (!user.tenantId && headerTenantId) { user.tenantId = headerTenantId }
//
// — when the token carries no tenant claim, the `x-tenant-id` REQUEST HEADER is copied onto the user
// object. So `user.tenantId` can be caller-supplied input wearing the costume of an identity. The
// verified-only value is preserved separately as `req.authenticatedTenantId`.
//
// That is exactly why the plugin cannot answer "is this data theirs" on its own, and it is not a
// hypothetical: `resolveTenantId` compares a request tenant against `user.tenantId`, so on a
// tenant-claimless deployment that comparison can be header-against-header. Harmless while every
// answer is a count; not harmless once the answer is a customer's project names.
//
// This module therefore does two things the rest of the plugin does not:
//   * it PREFERS `req.authenticatedTenantId` (the verified claim) and refuses outright when a header
//     tenant contradicts a verified one; and
//   * it makes the host VOUCH for the pairing, through a narrow, named, duck-typed capability
//     injected exactly as `governedAi` and `stockPreparationXlsxExport` are, in
//     packages/core-backend/src/index.ts:
//
//         tenantPrincipalDirectory: { verifyTenantMembership({ userId, tenantId }) => Promise<{ member }> }
//
//     backed host-side by the one membership relation that actually exists (`user_orgs`, the
//     `user_id / org_id / is_active` table the approval and attendance boundaries already key off).
//     The plugin never sees the SQL, the pool, or the table — it submits two identity strings and
//     receives one boolean, the same least-privilege port shape `attendanceImportRollback` uses.
//
// REQUIRED, not optional — unlike `governedAi`, which fail-opens to manual mapping. Absent, this
// refuses with 501 rather than proceeding on the request's own say-so. An optional verifier that
// silently no-ops on the deployment that lacks it verifies nothing, and "the deployment that lacks
// it" is precisely the tenant-claimless deployment where the header fallback is live.
//
// ORDER IS PART OF THE CONTRACT. Every refusal below that can be decided from the principal alone is
// decided BEFORE the host is called, and the host is called before any records/provisioning IO. An
// under-privileged or cross-tenant caller therefore costs zero IO — asserted by a suite, not assumed.

const { optionalString } = require('./stock-preparation-common.cjs')
const {
  STOCK_PREP_OPERATE,
  satisfiesStockPrepAccess,
} = require('./stock-preparation-workbench-access.cjs')

/** The permission tier a value-bearing operator read rides. Never widen this to STOCK_PREP_READ. */
const OPERATOR_VALUE_TIER = STOCK_PREP_OPERATE

class StockPreparationOperatorScopeError extends Error {
  constructor(status, code, message, details = {}) {
    super(message)
    this.name = 'StockPreparationOperatorScopeError'
    this.status = status
    this.code = code
    this.details = details
  }
}

/**
 * The caller's flattened permission list, in the SAME shape http-routes.cjs's `listUserPermissions`
 * produces (real codes plus synthesized `role:<x>` pseudo-codes). Kept here so this module can be
 * unit-tested against a bare user object without mounting the route table.
 */
function listPrincipalPermissions(user) {
  const permissions = []
  if (Array.isArray(user && user.permissions)) permissions.push(...user.permissions)
  if (Array.isArray(user && user.roles)) permissions.push(...user.roles.map((role) => `role:${role}`))
  if (user && typeof user.role === 'string') permissions.push(`role:${user.role}`)
  return permissions.map((permission) => String(permission))
}

/**
 * Does this principal hold the operator VALUE tier?
 *
 * Delegates to the frozen decision in stock-preparation-workbench-access.cjs — it does not restate
 * the ladder, so the conjunction (`operate` AND `read`) and the platform-admin short-circuit stay
 * defined in exactly one place. A platform admin passes this; they are then refused two steps later
 * for having no tenant of their own, which is the correct reason and the correct code.
 */
function holdsOperatorValueTier(user) {
  return satisfiesStockPrepAccess(listPrincipalPermissions(user), OPERATOR_VALUE_TIER)
}

/**
 * The principal's OWN tenant — never from a request body/query/param.
 *
 * `authenticatedTenantId` is the host's VERIFIED token claim; `user.tenantId` may be the `x-tenant-id`
 * header the middleware copied on when the token carried no claim (see the header). Prefer the
 * verified one; fall back to the user object only when there is no verified claim to prefer, in which
 * case the host membership check below is the thing that makes it safe.
 *
 * Returns `{ tenantId, contradicted }`. `contradicted` is true when a verified claim EXISTS and the
 * user object disagrees with it — a header that tried to override an identity, which is refused
 * rather than silently resolved in either direction.
 */
function ownTenantId(user, authenticatedTenantId) {
  const verified = optionalString(authenticatedTenantId) || ''
  const carried = optionalString(user && user.tenantId) || ''
  if (verified && carried && verified !== carried) return { tenantId: '', contradicted: true }
  return { tenantId: verified || carried, contradicted: false }
}

/**
 * The stable principal handle this scope travels under. `id` first, `email` only as the fallback the
 * confirm/export routes already use for `actor`, so an audit row keyed by this scope names the same
 * principal those routes name. Never a customer business value.
 */
function principalActorId(user) {
  return optionalString(user && user.id) || optionalString(user && user.email) || ''
}

/**
 * RESOLVE THE VERIFIED OWN-TENANT VALUE SCOPE, or refuse.
 *
 * @param {object}   params
 * @param {object}   params.user                  the authenticated principal (http-routes' getUser(req))
 * @param {string}   params.authenticatedTenantId `req.authenticatedTenantId` — the host's VERIFIED
 *                                                token tenant claim, absent when the token had none.
 * @param {string[]} params.explicitTenantIds     every tenantId the REQUEST carried, from any of
 *                                                body/query/params (http-routes' collectExplicitTenantIds).
 *                                                Each is compared against the principal's own tenant and
 *                                                any mismatch refuses — a request may echo the caller's
 *                                                own tenant (compatibility) but may never steer.
 * @param {object}   params.tenantPrincipalDirectory  the injected host capability (see the header).
 *
 * @returns {Promise<{ tenantId: string, actorId: string, tier: string, tenantClaimVerified: boolean }>}
 *
 * Refusal order — each decidable without the one after it, so the cheapest refusal happens first and
 * NOTHING below costs IO until every principal-only check has passed:
 *   401 OPERATOR_SCOPE_UNAUTHENTICATED      no principal at all
 *   403 OPERATOR_SCOPE_TIER_REQUIRED        principal lacks the operator value tier
 *   403 OPERATOR_SCOPE_TENANT_CONTRADICTED  a header tenant contradicted the verified token claim
 *   403 OPERATOR_SCOPE_TENANT_REQUIRED      principal has no tenant of its own  <- the platform side
 *   403 OPERATOR_SCOPE_TENANT_MISMATCH      the request tried to steer to another tenant
 *   403 OPERATOR_SCOPE_PRINCIPAL_UNKNOWN    principal has no stable id/email to travel under
 *   501 OPERATOR_SCOPE_DIRECTORY_UNAVAILABLE the host cannot vouch for principals here
 *   403 OPERATOR_SCOPE_TENANT_MEMBERSHIP_DENIED  the host says this principal is not in that tenant
 */
async function resolveOperatorValueScope({
  user,
  authenticatedTenantId,
  explicitTenantIds = [],
  tenantPrincipalDirectory,
} = {}) {
  if (!user) {
    throw new StockPreparationOperatorScopeError(401, 'OPERATOR_SCOPE_UNAUTHENTICATED', 'authentication is required for a value-bearing operator read')
  }

  // The tier check is repeated here even though the route's `requireAccess` already made it. This is
  // not redundancy for its own sake: this module is the thing a future value-bearing read will
  // require, and it must be impossible to reach a value scope by calling it from a route that forgot
  // its gate. The two agree by construction — both delegate to satisfiesStockPrepAccess.
  if (!holdsOperatorValueTier(user)) {
    throw new StockPreparationOperatorScopeError(403, 'OPERATOR_SCOPE_TIER_REQUIRED', 'a value-bearing operator read requires the stock-prep operator tier', {
      requiredPermission: OPERATOR_VALUE_TIER,
    })
  }

  const verifiedClaim = optionalString(authenticatedTenantId) || ''
  const { tenantId, contradicted } = ownTenantId(user, verifiedClaim)
  if (contradicted) {
    // A header tenant that disagrees with the verified token claim. There is no reading of that which
    // is a legitimate caller, so it is refused rather than resolved toward either side.
    throw new StockPreparationOperatorScopeError(403, 'OPERATOR_SCOPE_TENANT_CONTRADICTED', 'the carried tenant contradicts the verified tenant claim')
  }
  if (!tenantId) {
    // THE PLATFORM-SIDE REFUSAL. A tenantless platform admin lands here, deliberately: under "whose
    // data is it" they have no own tenant, so there is no tenant whose values they may be shown on
    // this surface. Their values-free routes are untouched and still answer for every tenant.
    throw new StockPreparationOperatorScopeError(403, 'OPERATOR_SCOPE_TENANT_REQUIRED', 'a value-bearing operator read requires a principal with its own tenant')
  }

  for (const explicit of explicitTenantIds) {
    const candidate = optionalString(explicit)
    if (candidate && candidate !== tenantId) {
      throw new StockPreparationOperatorScopeError(403, 'OPERATOR_SCOPE_TENANT_MISMATCH', 'tenant scope mismatch')
    }
  }

  const actorId = principalActorId(user)
  if (!actorId) {
    throw new StockPreparationOperatorScopeError(403, 'OPERATOR_SCOPE_PRINCIPAL_UNKNOWN', 'the principal carries no stable identifier')
  }

  if (!tenantPrincipalDirectory || typeof tenantPrincipalDirectory.verifyTenantMembership !== 'function') {
    throw new StockPreparationOperatorScopeError(501, 'OPERATOR_SCOPE_DIRECTORY_UNAVAILABLE', 'the host tenant principal directory is not available', {
      requiredMethods: ['verifyTenantMembership'],
    })
  }

  const verdict = await tenantPrincipalDirectory.verifyTenantMembership({ userId: actorId, tenantId })
  if (!verdict || verdict.member !== true) {
    throw new StockPreparationOperatorScopeError(403, 'OPERATOR_SCOPE_TENANT_MEMBERSHIP_DENIED', 'the principal is not a member of its own claimed tenant')
  }

  // `tenantClaimVerified` is reported, not enforced: a deployment whose tokens carry no tenant claim
  // is still served, because the host membership check above — not the claim — is what makes the
  // pairing safe there. It is surfaced so an audit row can record WHICH of the two proofs was
  // available without the route having to re-derive it.
  return { tenantId, actorId, tier: OPERATOR_VALUE_TIER, tenantClaimVerified: verifiedClaim === tenantId }
}

module.exports = {
  OPERATOR_VALUE_TIER,
  StockPreparationOperatorScopeError,
  resolveOperatorValueScope,
  __internals: {
    holdsOperatorValueTier,
    listPrincipalPermissions,
    ownTenantId,
    principalActorId,
  },
}
