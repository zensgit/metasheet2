/**
 * Lock-11 (writer org derivation) — the ONE `org_id` derivation primitive for `approval_instances`
 * create-time stamping (OD-L11-2 arm (i)).
 *
 * Ratified design: docs/development/approval-lock11-writer-org-derivation-20260822.md (RATIFIED
 * 2026-08-22, design only — see §10 for the binding rulings this slice implements). This module
 * lands ONLY the shared arm-(a) derivation used by W-1 (`POST /api/approvals`) and W-2 (the
 * multitable automation `start_approval` bridge) — see the lock §3-§7 for the full provenance.
 *
 * RULED ARMS THIS MODULE IMPLEMENTS (§10, not re-litigated here):
 *   D-3  Arm (a) — derive from the KEYING USER's active `user_orgs` memberships. Exactly one
 *        membership stamps; zero or two-or-more REFUSE. No `'default'` fallback, no DB DEFAULT,
 *        no COALESCE — a refusal is always a refusal, never a milder NULL/`'default'` write.
 *   D-4  Requester-keying — the caller supplies the KEYING USER id (W-1 and W-2 both resolve it
 *        to `requesterSnapshot.id` before calling in; see ApprovalProductService.ts `createApproval`
 *        §4 of the lock). This module has no opinion on WHO the keying user is — it only derives
 *        the org for whichever id it is given.
 *   D-9  Single `is_active` liveness, byte-agreement with the S1 reader's own predicate
 *        (`approval-instance-readability.ts`'s `viewerActiveOrgIds`) — so a row this module stamps
 *        is guaranteed readable by its own requester under that predicate. NO `users` join (the
 *        REJECTED shape is `AuthService.resolveSessionTenantId`'s dual-`is_active` JOIN — do not
 *        copy it: that helper also swallows DB errors and returns `undefined`, an explicitly
 *        rejected fail-OPEN posture for a fail-closed site).
 *   OD-L11-2 arm (i):
 *     1. Namespace — reads `user_orgs.org_id` and NOTHING else (no attendance org table, no
 *        `directory_integrations.org_id`, no plugin install tenant).
 *     2. Liveness — single `is_active`, on `user_orgs` only (see D-9 above).
 *     3. Failure shape — THROWS. Never returns `undefined`-then-NULL. A caller that let an
 *        `undefined` return reach a NULL/`'default'` write would reintroduce exactly the outage
 *        class OD-S1-9(a) refuses.
 *
 * Runs on the caller's SUPPLIED `queryFn` — callers MUST bind this to the open transaction client,
 * never the pool. A pool read here would be a TOCTOU against the authority rows the create
 * boundary already locked (see ApprovalProductService.ts `createApproval`'s FWB-0 Layer 2 guards
 * immediately preceding the derivation call site).
 */

export type ApprovalOrgDerivationQueryFn = (
  sql: string,
  params?: unknown[],
) => Promise<{ rows: unknown[] }>

/**
 * Thrown by `deriveApprovalInstanceOrgId` on refusal. Values-free by construction (OD-L11-3 arm
 * (i), D-3): carries no org id, no membership count, no user id — only the fixed reason code.
 * Callers translate this into their own transport shape:
 *   - W-1 (HTTP): `ServiceError(message, 422, 'APPROVAL_ORG_UNRESOLVED')` (see createApproval).
 *   - W-2 (bridge): propagated unchanged — the existing `startApproval` catch already calls
 *     `markBridgeFailed` then rethrows, so no new failure plumbing is needed.
 */
export class ApprovalOrgUnresolvedError extends Error {
  constructor(public readonly reason: 'zero_memberships' | 'multiple_memberships') {
    super('Approval instance org could not be resolved for the keying user')
    this.name = 'ApprovalOrgUnresolvedError'
  }
}

/**
 * Arm (a): derive the org to stamp on a new `approval_instances` row from the KEYING USER's
 * active `user_orgs` memberships. Exactly one ⇒ that org. Zero or ≥2 ⇒ throws
 * `ApprovalOrgUnresolvedError` (never a default, never NULL-then-COALESCE).
 *
 * `queryFn` MUST be bound to the open transaction client (see module docblock — TOCTOU note).
 */
export async function deriveApprovalInstanceOrgId(
  queryFn: ApprovalOrgDerivationQueryFn,
  keyingUserId: string,
): Promise<string> {
  const uid = typeof keyingUserId === 'string' ? keyingUserId.trim() : ''
  if (!uid) {
    throw new ApprovalOrgUnresolvedError('zero_memberships')
  }

  // Byte-identical to approval-instance-readability.ts's viewerActiveOrgIds SQL (D-9). No `users`
  // join — single `is_active` on `user_orgs` only.
  const result = await queryFn(
    `SELECT org_id FROM user_orgs WHERE user_id = $1 AND is_active = TRUE`,
    [uid],
  )
  const orgIds = (result.rows as Array<{ org_id?: string | null }>)
    .map((row) => row.org_id)
    .filter((orgId): orgId is string => typeof orgId === 'string' && orgId.trim().length > 0)

  if (orgIds.length === 1) {
    return orgIds[0]
  }
  throw new ApprovalOrgUnresolvedError(orgIds.length === 0 ? 'zero_memberships' : 'multiple_memberships')
}
