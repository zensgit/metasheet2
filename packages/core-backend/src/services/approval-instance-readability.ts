/**
 * Lock-10 (S1) — the ONE per-instance admission predicate for approval instances (OD-S1-1).
 *
 * Ratified design: docs/development/approval-lock10-instance-readability-20260821.md (Status:
 * RATIFIED 2026-08-21), plus the six by-reference owner rulings recorded in Lock-10 §5.1.1 / the
 * ledger / Lock-9 §4.1 (docs PR #5078, `dd7fa8630248`): L9-AMEND arm (a) EXECUTED (unblocks
 * OD-S1-10/OD-S1-16 and the C-1 migration — see the retirement note below), OD-S1-12 CONFIRMED
 * (detail/history 200->404 narrowing, platform ids only), OD-S1-7/C-2 CONFIRMED (metrics-ACL
 * widening for CC targets), OD-S1-17(c) RULED (c-i) UNION (org half = union over the viewer's
 * ACTIVE `user_orgs` memberships), OD-S1-8(d) RULED KEEP (DB-backed admin bypass stays).
 *
 * ============================================================================================
 * ARM TABLE (lock §1.1) — ALL FIVE arms, all RATIFIED, none owner-blocked as of 2026-08-21:
 * ============================================================================================
 *
 *   1. REQUESTER   — `i.requester_snapshot->>'id' = viewerId`, unconditional (OD-S1-3).
 *   2. SEAT         — `approval_assignments`, user- OR role-typed, `is_active`-INSENSITIVE — a
 *                     seat's membership is monotonic: requiring `is_active` would deny an approver
 *                     read access to the instance the moment their seat is deactivated, which is
 *                     what approving/rejecting/transferring DOES (OD-S1-4). NOTE:
 *                     `assignment_type = 'source_queue'` is NEVER matched here — PLM's
 *                     `source_queue` seat stores a PERMISSION CODE, not a user id, in
 *                     `assignee_id` (OD-S1-5; F-2). Only `'user'` and `'role'` are compared.
 *   3. PAST ACTOR   — `EXISTS (... approval_records r WHERE r.actor_id = viewerId)`, INCLUDING
 *                     `action = 'policy_denied'` rows (OD-S1-6). Admitted together with G-S1-6
 *                     (`tests/integration/approval-instance-readability-s1.db.test.ts`), which
 *                     proves the coupling that makes this safe: `policy_denied` cannot be
 *                     self-minted by a non-participant. The coupling is a STRUCTURAL fact, not a
 *                     per-request check — `ApprovalProductService.ts`'s dispatch choke requires a
 *                     seat for every verb EXCEPT `revoke` (`request.action !== 'revoke'`,
 *                     `:9091`), and `revoke` is the ONE verb whose `ACTION_POLICY_KEYS` entry is
 *                     `null` (`types/approval-product.ts:378`) — so `revoke` never reaches the
 *                     node-policy branch that inserts `policy_denied`, and every verb THAT DOES
 *                     reach it already required a seat to invoke. G-S1-6 gates this invariant
 *                     mechanically (iterating `ACTION_POLICY_KEYS`) AND proves it end-to-end over
 *                     the real dispatch choke (a seat-holder refused by node policy still reads the
 *                     instance; a non-participant's seat-gate-exempt attempt writes no row).
 *   4. CC TARGET    — `approval_records` `action = 'cc'`, user- or role-typed target, matching the
 *                     C-1/C-2 shape (OD-S1-7).
 *   5. ADMIN        — `EXISTS (SELECT 1 FROM users u WHERE u.id = viewerId AND u.is_active = TRUE
 *                     AND (u.is_admin = TRUE OR u.role = 'admin'))` (OD-S1-8, kept per OD-S1-8(d)).
 *                     DB-backed only — C-2's/C-3's JWT-claims admin readers are REJECTED as
 *                     canonical (OD-S1-17(a) below). `users.is_active = TRUE` gates only the
 *                     `users.role` column here, not `user_roles` rows read by `viewerRoles` — the
 *                     lock's own note that this asymmetry is not an oversight to "fix" (§1.2).
 *
 * OUT: `source_queue` assignments — EXCLUDED, not deferred (OD-S1-5).
 *
 * ============================================================================================
 * ORG PIN (OD-S1-9(f) + OD-S1-17(b) + OD-S1-17(c) arm (c-i)) — conjoined with the arm union,
 * BUT GATED BEHIND `APPROVAL_S1_ORG_PIN_ENABLED`, DEFAULT OFF. This is a deviation from the lock's
 * text and is disclosed here, in the PR body, and in the module's own gate suite — NOT a design
 * choice this module is authorized to make unilaterally, but a shipping-safety necessity forced by
 * two implementer findings the lock's own rulings do not resolve (B-1, B-2 in the S1 implementation
 * brief):
 *
 *   - B-1: class 1 (template-originated)'s backfill source — "the template's owning org" — DOES
 *     NOt EXIST. `approval_templates` carries no org/tenant column at this baseline.
 *   - B-2: class 3 (requester-resolvable)'s backfill launders `'default'` into essentially the
 *     whole platform population, because `zzzz20260114110000_create_user_orgs_table.ts:34-41`
 *     backfilled EVERY active user into `'default'` — precisely the `DEFAULT_ORG_ID` hole
 *     OD-S1-9(a) refuses, arriving through the backfill instead of through a column default.
 *
 * Consequence: Migration A (this slice) populates `org_id` for class 2 (attachment-bearing
 * instances) ONLY. Every other existing platform row's `org_id` is NULL, and OD-S1-9(e) rules NULL
 * org_id false for EVERYONE, admin included — quoted verbatim from the lock's §1.5(iii): "(e)
 * therefore governs only the genuinely-anomalous row — one whose org was lost, not one whose org
 * was never derivable." That sentence presumes the backfill succeeded; under B-1/B-2 it cannot,
 * for the bulk of rows, in this slice. Landing the pin LIVE here would deny the majority of
 * existing approval instances to their own legitimate requesters/approvers — an outage, not a
 * narrowing — on every S1 consumer (attachment routes, metrics, detail, history).
 *
 * The flag lives INSIDE the predicate (not at any call site) so there remains exactly ONE
 * predicate and ONE call path for every consumer — re-pointing the retirement's callers to a
 * route-level flag would recreate the two-predicate window the owner ruling forbids. Arms 1-5 are
 * ALWAYS live; only the `i.org_id = ANY(viewerOrgIds)` conjunct is dormant. Flip precondition: the
 * writers-stamp-org PR lands AND Migration B's backfill has actually run against production data
 * for classes 1/3/4/6 (not merely landed as migration code) — until then this is OFF.
 *
 * Discriminator (why OFF is not a new hole): today's ONLY comparable org check on the retired
 * C-1 attachment routes is `authorizeAttachmentDownload`'s INDEPENDENT gate 0
 * (`approval-attachment-storage.ts`, `viewerOrgId !== row.orgId` against the ALREADY-POPULATED,
 * NOT NULL `approval_attachments.org_id`) — untouched by this slice, still enforcing on every
 * attachment download regardless of this flag. The internal EXISTS-based org pin this module
 * REMOVES from the old `isInstanceParticipant` compared the SAME attachment org against a
 * caller-supplied `req.user.tenantId || 'default'` — given `user_orgs`'s blanket `'default'`
 * backfill, that check was already close to vacuous. Detail/history/metrics have NO comparable
 * per-request org check today at all. So flag-OFF is "no worse than status quo" everywhere S1
 * lands in this slice; flag-ON before the backfill completes is a hard outage. See G-S1-3/G-S1-10
 * in the gate suite, which force the flag on in-process to prove the pin's OWN correctness even
 * while it ships dormant, and the "shipped default is off" assertion that catches a silent flip.
 *
 * Fail-closed on any thrown lookup (OD-S1-1): a DB error denies, it never admits.
 */
import type { Queryable } from '../multitable/automation-durable-dispatcher'

/** Reads fresh on every call so a test can flip it around one assertion — never cached, never a
 *  predicate parameter (OD-S1-9(f): the caller never supplies the org; that generalizes to "no
 *  caller may influence whether the org pin applies" either). */
export function isOrgPinEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.APPROVAL_S1_ORG_PIN_ENABLED ?? '').trim().toLowerCase() === 'true'
}

/**
 * Canonical PLM-mirror id test — `id.startsWith('plm:')`. OD-S1-18(b) verbatim: "The CHECK's
 * predicate was matched against the runtime's own id test, not assumed: the three shipped
 * detectors are `routes/approvals.ts:94-96`, `routes/approval-history.ts:18-20` and
 * `ApprovalBridgeService.ts:113-115`, and all three are exactly `id.startsWith('plm:')`... It is
 * also fragile: the test is hand-copied into three separate private functions, so the implementing
 * slice must either consolidate them or gate the agreement." This module names this function as
 * the canonical form; `tests/unit/approval-instance-readability-plm-id-agreement.test.ts` gates
 * the three existing (now exported, additive-only) detectors' agreement with it.
 */
export function isPlmApprovalId(id: string): boolean {
  return id.startsWith('plm:')
}

/**
 * DB-rebuilt viewer roles for role-typed assignment/CC matching (OD-S1-17(a): "roles derived from
 * the DB, never from token claims"). This is the SAME canonical source C-1's own `viewerRoles`
 * used (`users.role` for an active user, unioned with `user_roles` joined to `roles`, contributing
 * both `role_id` and `name`) — including the deliberately-kept asymmetry: `users.is_active = TRUE`
 * gates only the `users.role` column, not the `user_roles` rows. `approval-attachment-runtime.ts`
 * now imports THIS export rather than keeping its own copy (OD-S1-16 retirement item 2), so there
 * is exactly one implementation.
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
 * The viewer's ACTIVE `user_orgs` memberships (OD-S1-17(c) arm (c-i): UNION over active
 * memberships). DB-derived only — no request context, matching the predicate's fixed
 * `(db, viewerId, instanceId)` signature (OD-S1-9(f)). Empty when the viewer holds no active
 * membership; conjoined via `= ANY(...)`, so an empty array denies (never "no constraint").
 */
async function viewerActiveOrgIds(db: Queryable, viewerId: string): Promise<string[]> {
  const result = await db.query(`SELECT org_id FROM user_orgs WHERE user_id = $1 AND is_active = TRUE`, [viewerId])
  return (result.rows as Array<{ org_id?: string | null }>)
    .map((row) => row.org_id)
    .filter((orgId): orgId is string => typeof orgId === 'string' && orgId.trim().length > 0)
}

/**
 * S1 — the unified per-instance readability admission predicate (OD-S1-1). Every consumer this
 * slice touches (attachment download/refs — C-1 retirement, metrics — C-2 replacement, detail,
 * history) calls this ONE function; `isInstanceParticipant` no longer exists as a separate
 * implementation (OD-S1-16). Fail-closed: any thrown lookup is caught and denies.
 */
export async function canReadApprovalInstance(
  db: Queryable,
  viewerId: string,
  instanceId: string,
): Promise<boolean> {
  if (!viewerId || !instanceId) return false
  // OD-S1-18 guard: never the arbiter for a PLM mirror id in v1 — both consumers that could reach
  // a `plm:` id (detail, history) branch to the PLM adapter BEFORE calling this predicate, so this
  // is defense-in-depth, not the primary enforcement. G-S1-4 proves the primary enforcement (a spy
  // counter, not this branch) is what actually keeps `plm:` ids off this predicate in practice.
  if (isPlmApprovalId(instanceId)) return false

  try {
    const roles = await viewerRoles(db, viewerId)
    const rolesParam = roles.length > 0 ? roles : ['__approval_instance_readability_no_role__']
    const pinEnabled = isOrgPinEnabled()
    const orgIds = pinEnabled ? await viewerActiveOrgIds(db, viewerId) : []
    const orgIdsParam = orgIds.length > 0 ? orgIds : ['__approval_instance_readability_no_org__']
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
               WHERE r.instance_id = i.id AND r.actor_id = $2
            )
            OR EXISTS (
              SELECT 1 FROM approval_records r
               WHERE r.instance_id = i.id AND r.action = 'cc'
                 AND ((r.metadata->>'targetType' = 'user' AND r.metadata->>'targetId' = $2)
                   OR (r.metadata->>'targetType' = 'role' AND r.metadata->>'targetId' = ANY($3::text[])))
            )
            OR EXISTS (
              SELECT 1 FROM users u WHERE u.id = $2 AND u.is_active = TRUE AND (u.is_admin = TRUE OR u.role = 'admin')
            )
          )
          AND ($4::boolean = FALSE OR i.org_id = ANY($5::text[]))
        LIMIT 1`,
      [instanceId, viewerId, rolesParam, pinEnabled, orgIdsParam],
    )
    return result.rows.length > 0
  } catch {
    // Fail-closed (OD-S1-1): any lookup error denies, never admits.
    return false
  }
}
