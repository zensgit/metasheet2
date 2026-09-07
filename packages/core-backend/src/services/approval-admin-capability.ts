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
 * This function answers exactly (3), so the client can gate on the same truth the list scope binds
 * instead of inferring it from a token. It is a READ of an existing predicate — it grants nothing,
 * widens nothing, and is never consulted as an authorization decision: `rbacGuard('approvals:admin')`
 * remains the sole gate on the reassign endpoint, and the list scope remains the sole gate on the
 * projection.
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
import type { Queryable } from '../multitable/automation-durable-dispatcher'

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
