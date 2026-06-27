/**
 * Approval ↔ requester ROLE resolution (READ-ONLY) — RA-1b.
 *
 * `requester.role in [...]` routes on the requester's CURRENT role membership, resolved by a FRESH
 * `user_roles` SELECT at create time — deliberately NOT the login-time token-claim `roles` carried on the
 * actor/JWT (which can be stale or applicant-influenced). The resolved role-id set is frozen into
 * `requester_snapshot.directoryRoles` at create and reloaded at dispatch, exactly like the directory
 * department/title snapshot fields, so routing is deterministic and tamper-resistant.
 *
 * BOUNDARY: this is a single read-only `SELECT role_id FROM user_roles` — it lives OUTSIDE
 * `ApprovalDirectoryOrg` (which is CI-boundary-locked to `directory_*` SELECTs) precisely because
 * `user_roles` is an RBAC table, not a directory table. It writes nothing and touches no `approval_*`
 * table.
 */

type QueryFn = <Row>(text: string, params?: unknown[]) => Promise<{ rows: Row[] }>

/**
 * Resolve the requester's role-id set from `user_roles` (deduped, blank-stripped, order-preserving).
 * Returns `[]` for a blank user id or a user with no roles. THROWS on a read failure — the caller
 * distinguishes a thrown read (transient → 503) from a successful empty read (genuine absence → 422) in
 * the create-time wedge guard, mirroring the directory department/title split.
 */
export async function resolveApprovalRequesterRoleIds(localUserId: string, query: QueryFn): Promise<string[]> {
  const userId = localUserId.trim()
  if (!userId) return []
  const rows = await query<{ role_id: string | null }>(
    `SELECT role_id FROM user_roles WHERE user_id = $1`,
    [userId],
  )
  const roles: string[] = []
  const seen = new Set<string>()
  for (const row of rows.rows) {
    const roleId = typeof row.role_id === 'string' ? row.role_id.trim() : ''
    if (roleId && !seen.has(roleId)) {
      seen.add(roleId)
      roles.push(roleId)
    }
  }
  return roles
}
