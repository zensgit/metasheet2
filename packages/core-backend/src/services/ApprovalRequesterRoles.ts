/**
 * Approval ↔ requester ROLE resolution (READ-ONLY) — RA-1b CURATED-VOCABULARY.
 *
 * `requester.role in [...]` routes on the requester's CURRENT role membership, resolved by a FRESH
 * `user_roles` SELECT at create time — deliberately NOT the login-time token-claim `roles` carried on the
 * actor/JWT (which can be stale or applicant-influenced). The resolved role-id set is frozen into
 * `requester_snapshot.directoryRoles` at create and reloaded at dispatch, exactly like the directory
 * department/title snapshot fields, so routing is deterministic and tamper-resistant.
 *
 * CURATED-ONLY (RA-1b vocabulary lock): the resolver INNER-JOINs `roles` and keeps ONLY roles with
 * `approval_usable = true`, so a SYSTEM/admin role the requester happens to hold can NEVER enter
 * `directoryRoles`. `role` is a routing PREDICATE, not a key: a requester with zero CURATED roles freezes
 * `[]`, intersects nothing, and routes to the condition's DEFAULT edge (membership = false) — it is NOT
 * rejected. Only a transient read FAILURE fails the create closed (503).
 *
 * BOUNDARY: this is a single read-only `SELECT … FROM user_roles JOIN roles` — it lives OUTSIDE
 * `ApprovalDirectoryOrg` (which is CI-boundary-locked to `directory_*` SELECTs) precisely because
 * `user_roles` / `roles` are RBAC tables, not directory tables. It writes nothing and touches no
 * `approval_*` table.
 */

type QueryFn = <Row>(text: string, params?: unknown[]) => Promise<{ rows: Row[] }>

/**
 * Resolve the requester's CURATED role-id set from `user_roles` JOIN `roles` where `approval_usable = true`
 * (deduped, blank-stripped, order-preserving). Returns `[]` for a blank user id, a user with no roles, or a
 * user whose roles are all uncurated. THROWS on a read failure — the caller treats a thrown read as
 * transient (→ 503) while a successful empty read is a GENUINE-EMPTY predicate (→ DEFAULT route), mirroring
 * the directory department/title read but NOT their reject-on-absence (those are routing keys; role is a
 * predicate).
 */
export async function resolveApprovalRequesterRoleIds(localUserId: string, query: QueryFn): Promise<string[]> {
  const userId = localUserId.trim()
  if (!userId) return []
  const rows = await query<{ role_id: string | null }>(
    `SELECT ur.role_id
       FROM user_roles ur
       JOIN roles r ON r.id = ur.role_id
      WHERE ur.user_id = $1 AND r.approval_usable = true`,
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
