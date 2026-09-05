/**
 * THE TENANT PRINCIPAL DIRECTORY — a narrow, least-privilege host port that answers exactly one
 * question for a plugin: **is this user really a member of this tenant?**
 *
 * ---------------------------------------------------------------------------
 * WHY A HOST PORT AT ALL
 * ---------------------------------------------------------------------------
 *
 * `plugin-integration-core` gained its first TENANT-SCOPED, VALUE-BEARING read (the stock-preparation
 * operator project directory: an operator sees their OWN factory's project numbers and names). Under
 * the ruled boundary — "whose data is it", not "which screen is it" — that read is only sound if the
 * caller's tenant is genuinely the caller's. The plugin cannot establish that alone, for a concrete
 * reason rather than a stylistic one:
 *
 *   `auth/jwt-middleware.ts` `hydrateAuthenticatedUser` copies the `x-tenant-id` REQUEST HEADER onto
 *   `user.tenantId` whenever the verified token carried no tenant claim. A plugin reading
 *   `req.user.tenantId` can therefore be reading caller-supplied input, not identity. (The verified
 *   value survives separately as `req.authenticatedTenantId`, which the plugin now prefers — but on a
 *   deployment whose tokens carry no claim there is nothing to prefer, and that is exactly the
 *   deployment where the header fallback is live.)
 *
 * So the host vouches instead, against the one membership relation that actually exists.
 *
 * ---------------------------------------------------------------------------
 * WHAT CROSSES THE BOUNDARY
 * ---------------------------------------------------------------------------
 *
 * IN:  two identity strings — `userId`, `tenantId`.
 * OUT: one boolean — `member`.
 *
 * That is the whole contract, and it is deliberately the same least-privilege port shape as
 * `createAttendanceImportRollbackBoundaryV1`: the plugin submits identity only; the host owns the
 * table, the SQL, the pool and the liveness predicate. The plugin never learns which table backs
 * this, never learns WHY a pairing failed, and cannot enumerate — a caller who asks about a pairing
 * they are not part of learns only `false`, the same answer a genuine non-membership yields.
 *
 * VALUES-FREE BY CONSTRUCTION. `userId` and `tenantId` are handles; the result is a boolean. No
 * customer business value can enter or leave through this port, so it adds no value surface to audit.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS DOES **NOT** GRANT
 * ---------------------------------------------------------------------------
 *
 *   * NOT an ACL check. It says nothing about bases, sheets, rows or fields, and it neither consults
 *     nor weakens multitable's ACL domain. A plugin holding a `true` from here still reads through
 *     its own service-account authority, scoped to the tenant it just proved.
 *   * NOT a permission. It confers no capability; the plugin's own gate (`stock-prep:operate`) is
 *     checked before this port is ever called.
 *   * NOT a workspace check. There is no user-to-workspace membership relation in this schema
 *     (`workspace_id` is a free-text scoping column on `platform_app_instances`, FK-backed by
 *     nothing), so this port deliberately does not pretend to answer that question. A future
 *     workspace-scoped read must add its own relation first rather than reinterpreting this boolean.
 *   * NOT a liveness check on the USER. It matches the single-`is_active`-on-`user_orgs` predicate
 *     the approval reader and writer already agree on (`approval-instance-org-derivation.ts` D-9), so
 *     a pairing this port admits is one those paths also treat as live. Deliberately no `users` join:
 *     that is the rejected dual-`is_active` shape, and copying it here would put this port out of
 *     byte-agreement with the predicate the rest of the platform uses.
 *
 * FAIL-CLOSED. Any malformed input, and any error the query raises, yields `member: false` — never a
 * throw the plugin might catch into a permissive branch, and never a silent `true`.
 */

export type TenantPrincipalDirectoryQueryFn = (
  sql: string,
  params?: unknown[],
) => Promise<{ rows: unknown[] }>

export interface TenantMembershipQueryV1 {
  readonly userId: string
  readonly tenantId: string
}

export interface TenantMembershipVerdictV1 {
  readonly member: boolean
}

export interface TenantPrincipalDirectoryV1 {
  verifyTenantMembership(input: TenantMembershipQueryV1): Promise<TenantMembershipVerdictV1>
}

export interface TenantPrincipalDirectoryDependenciesV1 {
  query: TenantPrincipalDirectoryQueryFn
}

const DENIED: TenantMembershipVerdictV1 = Object.freeze({ member: false })
const ADMITTED: TenantMembershipVerdictV1 = Object.freeze({ member: true })

/**
 * EXACT-SHAPE INPUT VALIDATION, mirroring `requireExactInput` in the attendance rollback boundary: a
 * non-plain object, a missing field, a non-string field, a blank field, or ANY extra key is refused.
 * The extra-key rule is the load-bearing one — it stops a caller smuggling a second selector past a
 * port whose whole security value is that it takes only two.
 */
function normalizeMembershipQuery(input: unknown): TenantMembershipQueryV1 | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null
  const keys = Reflect.ownKeys(input as object)
  if (keys.length !== 2) return null
  const record = input as Record<string, unknown>
  if (!Object.prototype.hasOwnProperty.call(record, 'userId')) return null
  if (!Object.prototype.hasOwnProperty.call(record, 'tenantId')) return null
  const userId = typeof record.userId === 'string' ? record.userId.trim() : ''
  const tenantId = typeof record.tenantId === 'string' ? record.tenantId.trim() : ''
  if (!userId || !tenantId) return null
  return Object.freeze({ userId, tenantId })
}

export function createTenantPrincipalDirectoryBoundaryV1(
  dependencies: TenantPrincipalDirectoryDependenciesV1,
): TenantPrincipalDirectoryV1 {
  if (
    typeof dependencies !== 'object' ||
    dependencies === null ||
    typeof dependencies.query !== 'function'
  ) {
    throw new Error('TENANT_PRINCIPAL_DIRECTORY_DEPENDENCIES_INVALID')
  }
  const { query } = dependencies
  return Object.freeze({
    async verifyTenantMembership(input: TenantMembershipQueryV1): Promise<TenantMembershipVerdictV1> {
      const normalized = normalizeMembershipQuery(input)
      if (!normalized) return DENIED
      try {
        // Byte-agreement with `approval-instance-org-derivation.ts`'s arm-(f) membership check:
        // single `is_active` on `user_orgs`, no `users` join. LIMIT 1 because the answer is a
        // boolean — this port must never be able to report HOW MANY memberships exist.
        const result = await query(
          `SELECT 1 FROM user_orgs WHERE user_id = $1 AND org_id = $2 AND is_active = TRUE LIMIT 1`,
          [normalized.userId, normalized.tenantId],
        )
        return Array.isArray(result?.rows) && result.rows.length > 0 ? ADMITTED : DENIED
      } catch {
        // FAIL-CLOSED. A database that cannot answer "is this user in this tenant" must not be read
        // as "yes". The plugin turns this into its own named 403 and returns no values.
        return DENIED
      }
    },
  })
}
