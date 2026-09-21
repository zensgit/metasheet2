/**
 * The DB-backed "approval administrator" capability, as a value a client can be told.
 *
 * WHY THIS EXISTS. Three different predicates decide whether a principal is an approval
 * administrator, and they do not agree:
 *
 *   1. the web client's route/nav gate — `getAccessSnapshot().isAdmin` in
 *      `apps/web/src/composables/useAuth.ts`: JWT/localStorage roles containing `admin`, or any of
 *      `*:*` / `admin:all` / `users:write` / `roles:write` / `permissions:write`;
 *   2. the reassign endpoint's guard — `rbacGuard('approvals:admin')`, a plain permission grant;
 *   3. the approval LIST SCOPE's admin arm — `users.is_active AND (is_admin OR role = 'admin')`,
 *      a `users`-table column read (`ApprovalBridgeService.buildApprovalListScopeCondition`, arm 5;
 *      `approval-instance-readability.canReadApprovalInstance`, arm 5, has the same shape).
 *
 * A principal admitted by (1)+(2) but not (3) reaches the admin batch-transfer page and is served a
 * SUBSET of the picked approver's queue — arms 1-4 only. When that subset is empty the page used to
 * state, as fact, that the approver has nothing to transfer. That is a claim about another user's
 * queue which a caller-scoped read cannot support.
 *
 * This function answers exactly (3)'s ADMIN ARM, so the client can gate on the same truth the list
 * scope binds instead of inferring it from a token. It is a READ of an existing predicate — it
 * grants nothing, widens nothing, and is never consulted as an authorization decision:
 * `rbacGuard('approvals:admin')` remains the sole gate on the reassign endpoint, and the list scope
 * remains the sole gate on the projection.
 *
 * WHAT "THE ADMIN ARM" LEAVES OUT — the org pin, and why this is a disclosure rather than a fix.
 * `buildApprovalListScopeCondition`'s arms are one conjunct of the list query. When
 * `APPROVAL_S1_ORG_PIN_ENABLED` is true (`approval-instance-readability.ts`; DEFAULT OFF, and the
 * shipped default is asserted by its own gate) `listApprovals` AND-s in a SECOND conjunct
 * (`ApprovalBridgeService.ts`, the `isOrgPinEnabled()` block): a platform row is admitted only if
 * its `org_id` is one of `viewerActiveOrgIds(viewer)`. So with the pin ON, a caller this function
 * calls an approval administrator still sees only the rows inside their own orgs.
 *
 * THAT CONJUNCT HAS NO CALLER-LEVEL COUNTERPART, which is why it is not mirrored here. It is a
 * relation between the viewer's orgs and EACH ROW's `org_id`, not a property of the viewer: no
 * boolean about the caller can express it. The nearest reusable approximation —
 * `isOrgPinEnabled() ? viewerActiveOrgIds(...).length > 0 : true` — would be a DIFFERENT predicate
 * that still fails to close the gap (a viewer WITH orgs is still outside some other org's rows),
 * would make this endpoint answer a question about visible rows rather than about the caller, would
 * add a query on a path that is dormant by default, and fails in the direction that HIDES the page
 * from a genuine administrator. It was considered and rejected.
 *
 * RESIDUAL, STATED PLAINLY: with the pin ON, a `granted` administrator who shares no org with the
 * picked approver's rows is served a narrowed queue, and the batch-transfer page's empty state then
 * asserts that the approver has nothing to transfer — the same over-strong claim this capability
 * closed on the token axis, surviving on the org axis. It is not reachable on the shipped default.
 * Whoever flips `APPROVAL_S1_ORG_PIN_ENABLED` owns closing it, and the page's empty-state copy is
 * where it has to be closed.
 *
 * DELIBERATELY A SECOND SITE, NOT A REFACTOR OF ARM 5. `buildApprovalListScopeCondition` is
 * Lock-10 / OD-S1-8 governed and its own docblock frames its arm 5 and
 * `approval-instance-readability`'s arm 5 as two deliberate artifacts that agree by inspection. A
 * shared SQL fragment would invert that: a ratified admission predicate would start depending on a
 * helper introduced for a client capability read. The predicate below is therefore written out and
 * pinned on its own arms (no row / inactive row / neither column set / each column set alone), with
 * a test that also reads the two existing sites' text so a divergence surfaces.
 *
 * NEVER FAILS CLOSED TO `false`. A lookup failure THROWS, so the route answers 500 and the client
 * renders a "could not confirm" state. Folding an error into `false` would reproduce the very
 * defect this closes: asserting something about a principal's rights that the read did not
 * establish.
 */
import type { Request, RequestHandler } from 'express'
import type { Queryable } from '../multitable/automation-durable-dispatcher'
import { Logger } from '../core/logger'
import { isAdmin, userHasPermission } from '../rbac/service'
import { isPermissionAllowedByNamespaceAdmission } from '../rbac/namespace-admission'

/**
 * The predicate text, byte-for-byte the condition arm 5 of the list scope applies to `users`
 * (modulo table alias and parameter number). Exported so a test can compare it against the two
 * existing sites instead of a hand-copied string.
 */
export const APPROVAL_ADMIN_CAPABILITY_PREDICATE =
  'is_active = TRUE AND (is_admin = TRUE OR role = \'admin\')'

export async function isApprovalAdministrator(db: Queryable, viewerId: string): Promise<boolean> {
  if (typeof viewerId !== 'string' || viewerId.trim().length === 0) return false
  const result = await db.query(
    `SELECT 1 FROM users WHERE id = $1 AND ${APPROVAL_ADMIN_CAPABILITY_PREDICATE} LIMIT 1`,
    [viewerId],
  )
  return result.rows.length > 0
}

/**
 * P4(2) phase 0 — the single resolver `census-tiered-admin-20260915.md` (Q1) and
 * `p4-2-tiered-admin-design-draft-20260915.md` (§3.2/§3.4) call for, collapsing the route-level
 * "is this viewer an approval admin FOR THIS CAPABILITY" gate that today is three differently-typed
 * literal guard expressions (one `rbacGuardAny`, two bare `rbacGuard('approvals:admin')`) plus one
 * inline `ensurePlatformAdmin` exception, into one function with one call shape.
 *
 * PHASE 0 IS A PURE EXTRACTION, NOT A REDESIGN. Every arm below is copied from, and ordered to
 * match, the private decision logic inside `rbacGuard`/`rbacGuardAny` (`rbac/rbac.ts`) — which this
 * file cannot import, because those two functions are RequestHandler *factories* with no exported
 * seam that returns a bare boolean, and `rbac/rbac.ts` backs unrelated (non-approval) routes
 * app-wide, so refactoring it to add one is out of this slice's blast radius. The arms are
 * therefore re-stated here, pinned to the ORIGINALS in the source line above each one, so a change
 * to `rbac/rbac.ts` that is not mirrored here is a drift a reviewer can literally diff for. This is
 * the same trade-off `APPROVAL_ADMIN_CAPABILITY_PREDICATE` above already made for arm 5 of the list
 * scope (a second, pinned, tested site — see that docblock) rather than reaching into a governed
 * file for reuse.
 *
 * WHAT "CAPABILITY" MEANS TODAY (phase 0 — the code is exactly as flat as it is on `main`):
 *
 *   template  → `approvalTemplateAdminGuard` = `rbacGuardAny(['approval-templates:manage',
 *               'approvals:admin-templates'])` (`routes/approvals.ts`) — template CRUD/publish/
 *               versions/directory-for-authoring, AND (exception 1, kept — see below) the four
 *               "admin edits someone else's delegation" routes at `/api/approval-delegations`
 *               (GET list-all, POST, PATCH, DELETE), which are PROCESS semantics wearing the
 *               TEMPLATE code today. Reclassifying them to `process` is a phase-1 decision, not a
 *               phase-0 one — phase 0 preserves today's actual gate.
 *   process   → `rbacGuard('approvals:admin')` on `/api/approvals/:id/jump` and
 *               `/api/approvals/admin/reassign` (`routes/approvals.ts`).
 *   data      → `rbacGuard('approvals:admin')` on the four `approval-metrics.ts` admin endpoints
 *               (summary/report/teams/breaches) — THE SAME CODE AS `process` today. The registered-
 *               but-unconsumed `approvals:admin-data` permission (census Q2: 2 hits, both non-guard)
 *               is DELIBERATELY NOT wired in here — doing so would ADMIT a holder denied today,
 *               which is a phase-1 widening, not a phase-0 extraction.
 *
 * THE TWO EXCEPTIONS census Q1 names, and how each is handled here:
 *
 *   1. `/api/approval-delegations` (admin arm, 4 routes) — process semantics, template gate. Kept
 *      AS-IS: routed through `resolveApprovalAdminCapability(viewer, 'template')`, i.e. the SAME
 *      permission codes the routes require today. The inconsistency is preserved, not corrected.
 *   2. `/api/approval-templates/directory/member-groups/:action(bind|unbind)` — gated by the inline
 *      `ensurePlatformAdmin(req, res)` (`routes/admin-users.ts`), DELIBERATELY STRONGER than every
 *      other route on this guard (platform-admin only; a `template`-capability holder who is not a
 *      platform admin is refused). `ensurePlatformAdmin`'s decision is `hasLegacyAdminClaim(req) ||
 *      await isRbacAdmin(userId)` — and `isRbacAdmin` there is `rbac/service.ts`'s `isAdmin`,
 *      IMPORTED BY THIS FILE TOO for arm 4 below: the DB half of that check is therefore ALREADY
 *      the same function this resolver calls, not a second copy. Only the TOKEN half differs
 *      (`hasLegacyAdminClaim` additionally admits a bare `perms` claim of `*:*`/`admin:all`, which
 *      no `template`/`process`/`data` capability check does on its non-trust-token path). Because
 *      that token predicate is WIDER than any of the three capabilities' token arm, routing this
 *      route through `resolveApprovalAdminCapability` with any of the three would NARROW who
 *      passes — a phase-0-breaking behavior change, not a preserving one. `ensurePlatformAdmin`
 *      also OWNS its response body (`jsonError`, a different envelope from the one this resolver's
 *      guard below writes) via a `Response` it is handed directly, so wrapping it would additionally
 *      have to reproduce that envelope byte-for-byte to stay parity-safe. The route's call to
 *      `ensurePlatformAdmin(req, res)` is therefore UNCHANGED, and this is the "保留,改动属阶段 1"
 *      exception named in the PR body — this docblock is where its decision source is catalogued so
 *      phase 1 has one place to reconcile it, not a code path that pretends the two are unified yet.
 *
 * THE ≥6 "IS THIS PRINCIPAL AN ADMIN" SOURCES `census-tiered-admin-20260915.md` (Q3) inventories are
 * NOT the edit surface of this phase — they are the evidence for why sources drift, cited here so
 * the drift is named once instead of re-discovered per capability:
 *   ① `rbac/rbac.ts` `requestUserIsAdmin` — app-wide infra backing every `rbacGuard*` call site
 *      (not approval-specific; mirrored, not imported, per the note above).
 *   ② `services/approval-attachment-runtime.ts` `principalHasApprovalsRead/Write/Act` — token-only,
 *      no DB fallback; gates attachment read/write/act, not an admin capability.
 *   ③ `services/ApprovalBridgeService.ts` (list-scope arm 5) and
 *      `services/approval-instance-readability.ts` (`canReadApprovalInstance` arm 5) — DB-only row
 *      filters, Lock-10 / OD-S1-8 governed; `APPROVAL_ADMIN_CAPABILITY_PREDICATE` above is already
 *      the deliberate second site for these and stays that way (see its docblock) — NOT folded into
 *      this resolver.
 *   ④ `routes/admin-users.ts` `hasLegacyAdminClaim` (token) OR `isRbacAdmin` (DB) via
 *      `ensurePlatformAdmin` — see exception 2 above.
 *   ⑤ `services/approval-record-link-txn-auth.ts` `loadApprovalDbIdentityOnQuery` — DB-only,
 *      transaction-boundary re-check for multitable record-link writes; not an HTTP route gate.
 *   ⑥ `multitable/automation-approval-template-access.ts` `automationTemplateVisibleToUser` — mixed
 *      DB check for workflow-automation template references, a different call shape (visibility,
 *      not a route gate) from all of the above.
 *
 * FAIL-CLOSED, AND VERIFIED — NOT JUST ARGUED — TO STILL BE PARITY ON THE ERROR PATH. Any thrown
 * error (a query against `user_roles`/`user_permissions` failing — DB unreachable, or a schema
 * error not otherwise degraded) resolves to `{ allowed: false, reason: 'error' }`; this function
 * itself never throws. The guard built on top of it (below) checks `reason === 'error'` BEFORE
 * falling through to 403 and answers 500 in that case too — the same status `rbacGuard`'s own
 * `catch` gives today. This was checked empirically, not assumed: with `user_roles` renamed out
 * from under a live DB (a real per-query Postgres error, the same fault `isAdmin` would see on a
 * degraded table — a full container stop instead crashes the WHOLE process via an unhandled `pg`
 * pool `error` event, on both trees identically, which is a pre-existing hazard unrelated to this
 * change and not what this probe is about), `GET /api/approvals/metrics/summary` answered 500 for
 * BOTH a platform-admin and a plain viewer on the pre-resolver tree, and 500 for both on this one.
 * The error path is therefore ALSO zero-behavior-change, not merely "unobservably different" — the
 * internal control flow no longer throws past this function, but nothing an HTTP caller can see
 * moved. A future phase-1 caller that is NOT the HTTP guard (e.g. a background job resolving a
 * grant) gets the fail-closed boolean directly, without having to also know to catch.
 */
export type ApprovalAdminCapability = 'template' | 'process' | 'data'

export type ApprovalAdminCapabilityReason = 'platform-admin' | 'permission' | 'none' | 'error'

export interface ApprovalAdminCapabilityDecision {
  allowed: boolean
  reason: ApprovalAdminCapabilityReason
}

/**
 * Reserved for phase 1 (`approval_admin_grants` scope evaluation — design draft §3.3). Phase 0 has
 * no scoped grants table, so every capability here is still the flat, global permission code it is
 * today; a `target` is accepted (so call sites do not have to change shape again in phase 1) but is
 * NOT YET read by anything below.
 */
export interface ApprovalAdminCapabilityTarget {
  templateId?: string
  orgUnitId?: string
  instanceId?: string
}

/** The subset of `req.user` every arm below reads. Deliberately NOT `Express.Request['user']`
 *  itself — this file has no reason to depend on the global Express augmentation for a handful of
 *  claim fields it already has to normalize defensively regardless of their declared type. */
export interface ApprovalAdminCapabilityViewer {
  id?: string | number
  role?: unknown
  roles?: unknown
  permissions?: unknown
  perms?: unknown
}

const logger = new Logger('ApprovalAdminCapability')

// Mirrors `rbac/rbac.ts`'s private `trustTokenClaims` constant by name and by the exact same env
// parse — see the docblock above for why this is a mirror rather than an import.
const RBAC_TOKEN_TRUST_ENABLED =
  process.env.RBAC_TOKEN_TRUST === 'true' || process.env.RBAC_TOKEN_TRUST === '1'

// Mirrors `rbac/rbac.ts`'s private `normalizeStringArray`.
function normalizeClaimArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map((item) => String(item ?? '').trim()).filter(Boolean)
}

// Mirrors `rbac/rbac.ts`'s private `hasPermissionCode` (exact-code or `<resource>:*`/`*:*` wildcard).
function hasPermissionCode(permissionCodes: string[], permissionCode: string): boolean {
  if (permissionCodes.includes(permissionCode) || permissionCodes.includes('*:*')) return true
  const resource = permissionCode.split(':')[0]
  return resource ? permissionCodes.includes(`${resource}:*`) : false
}

// Mirrors `rbac/rbac.ts`'s private `requestUserIsAdmin` — token `role`/`roles` ONLY (unlike
// `admin-users.ts`'s `hasLegacyAdminClaim`, this does not additionally read a bare `perms` claim;
// see exception 2 above for why that difference cannot be collapsed in phase 0).
function isTokenClaimedPlatformAdmin(viewer: ApprovalAdminCapabilityViewer): boolean {
  if (viewer.role === 'admin') return true
  return normalizeClaimArray(viewer.roles).includes('admin')
}

// The permission code(s) each capability accepts today — see the docblock's "WHAT CAPABILITY MEANS
// TODAY" section for the file:line provenance of each list.
const CAPABILITY_PERMISSION_CODES: Readonly<Record<ApprovalAdminCapability, readonly string[]>> = {
  template: ['approval-templates:manage', 'approvals:admin-templates'],
  process: ['approvals:admin'],
  data: ['approvals:admin'],
}

export async function resolveApprovalAdminCapability(
  viewer: ApprovalAdminCapabilityViewer,
  capability: ApprovalAdminCapability,
  _target?: ApprovalAdminCapabilityTarget,
): Promise<ApprovalAdminCapabilityDecision> {
  const codes = CAPABILITY_PERMISSION_CODES[capability]
  try {
    // Arm 1 (mirrors `rbacGuard`/`rbacGuardAny`'s FIRST check) — token-claimed platform admin.
    if (isTokenClaimedPlatformAdmin(viewer)) {
      return { allowed: true, reason: 'platform-admin' }
    }

    const userId = viewer?.id != null ? String(viewer.id) : ''

    // Arm 2 — token-RESOLVED permission array (`req.user.permissions`, hydrated from DB by
    // `AuthService.resolveRbacProfile` on every authenticated request outside trust-token mode;
    // namespace admission is a documented no-op for every `approvals:*` code — census Q2).
    const tokenPermissions = normalizeClaimArray(viewer?.permissions)
    for (const code of codes) {
      if (
        hasPermissionCode(tokenPermissions, code)
        && await isPermissionAllowedByNamespaceAdmission(userId, code)
      ) {
        return { allowed: true, reason: 'permission' }
      }
    }

    // Arm 3 — `RBAC_TOKEN_TRUST` raw `perms[]` claim, dormant unless that env flag is set.
    if (RBAC_TOKEN_TRUST_ENABLED) {
      if (normalizeClaimArray(viewer?.roles).includes('admin')) {
        return { allowed: true, reason: 'platform-admin' }
      }
      const trustedPerms = normalizeClaimArray((viewer as { perms?: unknown })?.perms)
      for (const code of codes) {
        if (
          hasPermissionCode(trustedPerms, code)
          && await isPermissionAllowedByNamespaceAdmission(userId, code)
        ) {
          return { allowed: true, reason: 'permission' }
        }
      }
    }

    if (!userId) {
      return { allowed: false, reason: 'none' }
    }

    // Arm 4 — DB: `user_roles` carries the platform `admin` role (`rbac/service.ts` `isAdmin` — the
    // SAME function `admin-users.ts`'s `ensurePlatformAdmin` calls as `isRbacAdmin`; see exception 2).
    if (await isAdmin(userId)) {
      return { allowed: true, reason: 'platform-admin' }
    }

    // Arm 5 — DB: `user_permissions` ∪ `role_permissions` ∪ legacy `users.permissions`, per code.
    for (const code of codes) {
      if (await userHasPermission(userId, code)) {
        return { allowed: true, reason: 'permission' }
      }
    }

    return { allowed: false, reason: 'none' }
  } catch (error) {
    logger.error(
      `approval admin capability resolution failed (capability=${capability})`,
      error instanceof Error ? error : undefined,
    )
    return { allowed: false, reason: 'error' }
  }
}

/**
 * The route middleware built on `resolveApprovalAdminCapability`. Response envelope is
 * byte-identical to `rbacGuard`/`rbacGuardAny`'s (`rbac/rbac.ts`) for all three codes it can emit —
 * 401 `{ error: 'Authentication required' }`, 403 `{ error: 'Insufficient permissions' }`, 500
 * `{ error: 'Permission check failed' }` — which is what the phase-0 zero-behavior-change parity
 * proof (design draft §4.B) turns on: this is the one thing about the swap an HTTP caller can
 * observe, and it does not change.
 */
export function approvalAdminCapabilityGuard(capability: ApprovalAdminCapability): RequestHandler {
  return async (req: Request, res, next): Promise<void> => {
    const userId = req.user?.id?.toString()
    if (!userId) {
      res.status(401).json({ error: 'Authentication required' })
      return
    }
    const decision = await resolveApprovalAdminCapability(
      req.user as ApprovalAdminCapabilityViewer,
      capability,
    )
    if (decision.allowed) {
      next()
      return
    }
    if (decision.reason === 'error') {
      res.status(500).json({ error: 'Permission check failed' })
      return
    }
    logger.warn(`Access denied for user ${userId}: missing approval ${capability} admin capability`)
    res.status(403).json({ error: 'Insufficient permissions' })
  }
}
