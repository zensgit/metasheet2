/**
 * SPIKE 1 (DRAFT prototype — pure functions, no DB, no wiring).
 * Baseline: main @ c5a4a94f7 (frozen).
 *
 * Illustrates the CORE authorization decision the schema in
 * spike1-principal-migration.draft.sql is designed to make.
 *
 * The DB (composite FK) already guarantees a grant and its principal share a
 * tenant; `sameTenant` here models the RUNTIME cross-check the caller does
 * against the request's tenant context (tenant-context.ts:20) — belt and
 * braces, mirroring the fact that today's DataSourceManager.assertAccess
 * (DataSourceManager.ts:380) is the ONLY line of defense and it ignores tenant.
 *
 * Nothing here touches application code; it is a reference implementation.
 */

export type PrincipalKind =
  | 'automation'
  | 'integration'
  | 'connector'
  | 'system_migration'
  | 'service'

/** Minimal projection of a service_principals row needed for the decision. */
export interface PrincipalState {
  id: string
  tenantId: string
  kind: PrincipalKind
  /** ISO timestamp or null. Non-null => retired (authority revoked). */
  revokedAt: string | null
}

/** Minimal projection of a writer_grants row. */
export interface WriterGrant {
  id: string
  tenantId: string
  principalId: string
  targetKind: 'base' | 'sheet' | 'data_source'
  targetId: string
  /** ISO timestamp or null. Non-null => grant retired. */
  revokedAt: string | null
}

export type WritabilityDecision =
  | { allow: true }
  | { allow: false; reasons: DenyReason[] }

export type DenyReason =
  | 'principal_revoked'
  | 'grant_revoked'
  | 'tenant_mismatch'
  | 'principal_grant_id_mismatch'

/**
 * Pure core: may this grant authorize a write, given the principal's current
 * lifecycle state and whether the request tenant matches?
 *
 * Fail-closed and reason-complete: accumulates EVERY applicable deny reason
 * (not short-circuit) so callers/audit see the full picture. Revocation of
 * either the principal or the grant is sufficient to deny; a tenant mismatch
 * is always fatal.
 *
 * Note: this decides AUTHORITY only. It never mutates or forgets identity —
 * resolving a historical actor is a separate concern (resolveHistoricalActor).
 */
export function resolvePrincipalWritability(
  grant: WriterGrant,
  principalState: PrincipalState,
  sameTenant: boolean
): WritabilityDecision {
  const reasons: DenyReason[] = []

  // The grant must actually be about this principal (guards a mis-joined call).
  if (grant.principalId !== principalState.id) {
    reasons.push('principal_grant_id_mismatch')
  }

  // Runtime tenant cross-check. The DB composite FK guarantees grant.tenantId
  // === principal.tenantId at rest; here we also require the REQUEST tenant to
  // match, and defensively re-check the two rows agree.
  if (!sameTenant || grant.tenantId !== principalState.tenantId) {
    reasons.push('tenant_mismatch')
  }

  // Revocation kills authority. Principal revoke invalidates ALL its grants.
  if (principalState.revokedAt !== null) {
    reasons.push('principal_revoked')
  }
  if (grant.revokedAt !== null) {
    reasons.push('grant_revoked')
  }

  if (reasons.length > 0) {
    return { allow: false, reasons }
  }
  return { allow: true }
}

/**
 * Audit resolution is DELIBERATELY independent of authorization.
 *
 * meta_record_revisions.actor_id is free text with no FK
 * (zzzz20260430172000_create_meta_record_revisions.ts:15). Because principals
 * are never physically deleted and ids are never reused, a historical actor_id
 * always resolves to its ORIGINAL principal — revoked or not. Revocation must
 * NOT change what history points at.
 *
 * Returns the principal if the id is known, else an 'unresolved' marker
 * (legacy human/string actors won't be in the registry).
 */
export function resolveHistoricalActor(
  actorId: string | null,
  registry: ReadonlyMap<string, PrincipalState>
): PrincipalState | { unresolved: true; actorId: string | null } {
  if (actorId === null) return { unresolved: true, actorId: null }
  const found = registry.get(actorId)
  return found ?? { unresolved: true, actorId }
}

/**
 * Rebinding guard, pure form of the SQL BEFORE UPDATE trigger
 * (writer_grants_forbid_rebind). A grant's principal_id is immutable; to move
 * a grant you revoke + recreate. Returns the list of immutable violations.
 */
export function assertGrantRebindAllowed(
  current: Pick<WriterGrant, 'principalId' | 'tenantId'>,
  next: Pick<WriterGrant, 'principalId' | 'tenantId'>
): { ok: true } | { ok: false; violations: Array<'principal_id' | 'tenant_id'> } {
  const violations: Array<'principal_id' | 'tenant_id'> = []
  if (current.principalId !== next.principalId) violations.push('principal_id')
  if (current.tenantId !== next.tenantId) violations.push('tenant_id')
  return violations.length === 0 ? { ok: true } : { ok: false, violations }
}
