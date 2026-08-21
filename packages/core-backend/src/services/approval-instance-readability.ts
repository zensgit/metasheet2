/**
 * Lock-10 (S1) — the ONE per-instance admission predicate for approval instances (OD-S1-1).
 *
 * Ratified design: docs/development/approval-lock10-instance-readability-20260821.md (Status:
 * RATIFIED 2026-08-21). "Design authority ONLY... every OD still needs its own PR". This module
 * implements the ARM SET the lock's §5.1 table marks RATIFIED-and-not-owner-blocked. It is
 * DELIBERATELY INERT: nothing in this PR calls `canReadApprovalInstance` from a route, a feed, or
 * any other consumer. Wiring a consumer to it is a SEPARATE, later slice — see "WHAT THIS SLICE
 * DOES NOT DO" below, which names every OD that blocks that wiring.
 *
 * ============================================================================================
 * ARM TABLE IMPLEMENTED HERE (lock §1.1) — four of the lock's five arms, all RATIFIED and none
 * OWNER-CONFIRM-blocked:
 * ============================================================================================
 *
 *   1. REQUESTER   — `i.requester_snapshot->>'id' = viewerId`, unconditional (OD-S1-3, RATIFIED).
 *   2. SEAT         — `approval_assignments`, user- OR role-typed, `is_active`-INSENSITIVE — a
 *                     seat's membership is monotonic: requiring `is_active` would deny an approver
 *                     read access to the instance the moment their seat is deactivated, which is
 *                     what approving/rejecting/transferring DOES (OD-S1-4, RATIFIED). NOTE:
 *                     `assignment_type = 'source_queue'` is NEVER matched here — PLM's
 *                     `source_queue` seat stores a PERMISSION CODE, not a user id, in
 *                     `assignee_id` (OD-S1-5, RATIFIED; F-2). Only `'user'` and `'role'` are
 *                     compared.
 *   3. PAST ACTOR   — `EXISTS (... approval_records r WHERE r.actor_id = viewerId)`, EXCLUDING
 *                     `action = 'policy_denied'` rows. OD-S1-6 (RATIFIED) admits `policy_denied`
 *                     ONLY TOGETHER WITH a gate proving, over the REAL dispatch choke, that (a) a
 *                     seat-holder refused by node policy writes the row and still reads the
 *                     instance, (b) a non-participant attempting each seat-gate-exempt verb writes
 *                     NO row, and (c) the mechanical enumeration over `ACTION_POLICY_KEYS` covers
 *                     every non-null key — with the fixture pinning an EXPLICIT `false` policy
 *                     (widen-only semantics make ABSENT ≡ ALLOWED, so an omitted key would make the
 *                     gate pass vacuously). That machinery lives in Lock-5's own dispatch choke
 *                     (`ApprovalProductService.ts`) and its 1000+-line real-DB suite
 *                     (`approval-node-operation-policy.db.test.ts`); re-exercising it end-to-end
 *                     from this slice was assessed and NOT built. Per OD-S1-6's own verbatim
 *                     fallback — "if G-S1-6 cannot be written, the arm excludes `policy_denied`" —
 *                     this arm takes that fallback rather than admit on an unverified claim.
 *   4. CC TARGET    — `approval_records` `action = 'cc'`, user- or role-typed target, matching the
 *                     C-1/C-2 shape (OD-S1-7, RATIFIED as a predicate arm).
 *
 * ============================================================================================
 * WHAT THIS SLICE DOES NOT DO — every omission below is a NAMED OWNER-CONFIRM row in the lock's
 * §5.1 table, re-verified directly against the lock text on `origin/main` before this PR was
 * opened, not an unmentioned gap:
 * ============================================================================================
 *
 *   - NO ADMIN ARM. OD-S1-8 ratifies the DB-backed shape (`users.is_active = TRUE AND
 *     (is_admin OR role='admin')`) *as a design*, but OD-S1-8(d) — whether to keep or drop the
 *     admin arm AT ALL — is its own row, bucketed OWNER-CONFIRM (§5.1), not authorized. Landing an
 *     admin arm here would be choosing an unruled arm-list question unilaterally.
 *   - NO ORG PIN / ORG PARAMETER. Three independent reasons converge, so this predicate takes only
 *     `(db, viewerId, instanceId)` — no `orgId` parameter — deliberately narrower than C-1's
 *     four-parameter `isInstanceParticipant`:
 *       (i)   OD-S1-17(c) (multi-org viewers: union / exact-org / single-org-with-boot-assert) is
 *             OWNER-CONFIRM and UNRULED — there is no defined semantics for "the viewer's org" to
 *             encode yet.
 *       (ii)  This PR's migration is Phase-1-only (see the migration file's docblock): `org_id` is
 *             NULL on effectively every row at this baseline. OD-S1-9(e) rules NULL org_id ⇒ false
 *             for everyone including admins — wiring a live org conjunct today would be a total
 *             lockout, not a narrowing.
 *       (iii) C-1's existing attachment-EXISTS org pin is REMOVED and replaced by an
 *             INSTANCE-level org pin as a PAIR (OD-S1-10) — but OD-S1-10's implementation is
 *             BLOCKED on the owner-confirm row `L9-AMEND` (Lock-9's OD-L9-13(a) says
 *             `isInstanceParticipant` is reused "UNCHANGED"; only an owner-authorized amendment to
 *             that RATIFIED Lock-9 text lets S1 replace it). Doing the removal half without the
 *             addition half — or landing a second, narrower org-pinned predicate alongside the
 *             still-live C-1 — would be exactly the
 *             `feedback_second_narrower_artifact_is_contract_narrowing` failure mode.
 *   - NO ROUTE / FEED ADOPTION. `GET /api/approvals/:id`, `GET /api/approvals/:id/history`, the
 *     metrics route, `listApprovals`'s tabs, comments, and `isInstanceParticipant` itself are all
 *     UNTOUCHED by this PR. OD-S1-12 (the detail/history 200->404 narrowing) is its own
 *     OWNER-CONFIRM row, "explicitly NOT inferred from 「按建议执行」". OD-S1-16
 *     (`isInstanceParticipant` ceases to exist) is design-ratified but implementation-BLOCKED on
 *     the same `L9-AMEND` row as OD-S1-10.
 *   - `plm:`-prefixed instance ids are NEVER admitted through this predicate (OD-S1-18: PLM
 *     mirrors are scoped OUT of S1's consumers in v1). Since no consumer calls this predicate yet,
 *     that guard is enforced HERE, defensively, as `isPlmApprovalId` fail-closed — see below.
 *   - ARM 3 EXCLUDES `policy_denied` — this takes OD-S1-6's own explicit fallback ("if G-S1-6
 *     cannot be written, the arm excludes `policy_denied`") rather than admit on an unverified
 *     claim. See the arm-3 line above for the full reasoning.
 *
 * Fail-closed on any thrown lookup (OD-S1-1): a DB error denies, it never admits.
 */
import type { Queryable } from '../multitable/automation-durable-dispatcher'

/**
 * Canonical PLM-mirror id test — `id.startsWith('plm:')`. The lock's OD-S1-18(b) verbatim: "The
 * CHECK's predicate was matched against the runtime's own id test, not assumed: the three shipped
 * detectors are `routes/approvals.ts:94-96`, `routes/approval-history.ts:18-20` and
 * `ApprovalBridgeService.ts:113-115`, and all three are exactly `id.startsWith('plm:')`... It is
 * also fragile: the test is hand-copied into three separate private functions, so the implementing
 * slice must either consolidate them or gate the agreement." This module does not touch those three
 * files (out of scope for an inert slice), but names this function as the canonical form and gates
 * the three existing detectors' agreement with it in
 * `tests/unit/approval-instance-readability-plm-id-agreement.test.ts`.
 */
export function isPlmApprovalId(id: string): boolean {
  return id.startsWith('plm:')
}

/**
 * DB-rebuilt viewer roles for role-typed assignment/CC matching (OD-S1-17(a), RATIFIED — "roles
 * derived from the DB, never from token claims"). Implemented FRESH here rather than imported from
 * `approval-attachment-runtime.ts:177-191` — that function is C-1's, and C-1 is retired/re-pointed
 * only once `L9-AMEND` is answered (see the module docblock); this slice does not refactor or touch
 * that file. The two derivations are intentionally the SAME canonical source
 * (`users.role` for an active user, unioned with `user_roles` joined to `roles`, contributing both
 * `role_id` and `name`), including the deliberately-kept asymmetry: `users.is_active = TRUE` gates
 * only the `users.role` column, not the `user_roles` rows — the lock's own note that this is not an
 * oversight to "fix".
 */
export async function viewerRoles(db: Queryable, viewerId: string): Promise<string[]> {
  const roles = new Set<string>()
  const userResult = await db.query(`SELECT role FROM users WHERE id = $1 AND is_active = TRUE`, [viewerId])
  const role = (userResult.rows[0] as { role?: string | null } | undefined)?.role
  if (typeof role === 'string' && role.trim()) roles.add(role.trim())
  const roleRows = await db.query(
    `SELECT ur.role_id, r.name FROM user_roles ur LEFT JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = $1`,
    [viewerId],
  )
  for (const row of roleRows.rows as Array<{ role_id?: string | null; name?: string | null }>) {
    if (typeof row.role_id === 'string' && row.role_id.trim()) roles.add(row.role_id.trim())
    if (typeof row.name === 'string' && row.name.trim()) roles.add(row.name.trim())
  }
  return [...roles]
}

/**
 * S1 — the unified per-instance readability admission predicate (OD-S1-1). Implements arms 1-4
 * only; see the module docblock for exactly which arms and consumers are out of scope for this
 * slice and why. Fail-closed: any thrown lookup is caught and denies.
 */
export async function canReadApprovalInstance(
  db: Queryable,
  viewerId: string,
  instanceId: string,
): Promise<boolean> {
  if (!viewerId || !instanceId) return false
  // OD-S1-18 defensive guard: this predicate is never the arbiter for a PLM mirror id in v1. No
  // consumer wires this predicate to a route in this slice, so this branch has no live caller yet;
  // it exists so a future caller that DOES wire a `plm:` id through this predicate fails closed
  // instead of accidentally admitting on a coincidental arm match (e.g. a requester_snapshot that
  // happens to carry the viewer's id).
  if (isPlmApprovalId(instanceId)) return false

  try {
    const roles = await viewerRoles(db, viewerId)
    const rolesParam = roles.length > 0 ? roles : ['__approval_instance_readability_no_role__']
    const result = await db.query(
      `SELECT 1 FROM approval_instances i
        WHERE i.id = $1
          AND (
            i.requester_snapshot->>'id' = $2
            OR EXISTS (
              SELECT 1 FROM approval_assignments a
               WHERE a.instance_id = i.id
                 AND ((a.assignment_type = 'user' AND a.assignee_id = $2)
                   OR (a.assignment_type = 'role' AND a.assignee_id = ANY($3::text[])))
            )
            OR EXISTS (
              SELECT 1 FROM approval_records r
               WHERE r.instance_id = i.id AND r.actor_id = $2 AND r.action <> 'policy_denied'
            )
            OR EXISTS (
              SELECT 1 FROM approval_records r
               WHERE r.instance_id = i.id AND r.action = 'cc'
                 AND ((r.metadata->>'targetType' = 'user' AND r.metadata->>'targetId' = $2)
                   OR (r.metadata->>'targetType' = 'role' AND r.metadata->>'targetId' = ANY($3::text[])))
            )
          )
        LIMIT 1`,
      [instanceId, viewerId, rolesParam],
    )
    return result.rows.length > 0
  } catch {
    // Fail-closed (OD-S1-1): any lookup error denies, never admits.
    return false
  }
}
