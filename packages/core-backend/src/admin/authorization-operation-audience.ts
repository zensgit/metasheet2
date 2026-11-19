import type { OperationQuery } from './authorization-operation-snapshot'

export async function isUserWithinDelegatedScope(
  adminUserId: string,
  namespaces: string[],
  userId: string,
  runQuery: OperationQuery,
): Promise<boolean> {
  if (namespaces.length === 0) return false

  const result = await runQuery(
    `WITH RECURSIVE seed_departments AS (
        SELECT d.id,
               d.integration_id,
               d.external_department_id,
               bool_or(COALESCE(s.include_children, TRUE)) AS include_children
        FROM delegated_role_admin_scopes s
        JOIN directory_departments d ON d.id = s.directory_department_id
        WHERE s.admin_user_id = $1
          AND s.namespace = ANY($2::text[])
          AND d.is_active = true
        GROUP BY d.id, d.integration_id, d.external_department_id
      ),
      allowed_departments AS (
        SELECT id, integration_id, external_department_id, include_children
        FROM seed_departments
        UNION
        SELECT child.id, child.integration_id, child.external_department_id, TRUE AS include_children
        FROM directory_departments child
        JOIN allowed_departments parent
         ON child.integration_id = parent.integration_id
         AND child.external_parent_department_id = parent.external_department_id
        WHERE parent.include_children IS TRUE
          AND child.is_active = true
      ),
      allowed_groups AS (
        SELECT DISTINCT gscope.group_id
        FROM delegated_role_admin_member_groups gscope
        WHERE gscope.admin_user_id = $1
          AND gscope.namespace = ANY($2::text[])
      )
      SELECT EXISTS (
        SELECT 1
        FROM directory_account_links l
        JOIN directory_accounts a
          ON a.id = l.directory_account_id
         AND a.is_active = true
        JOIN directory_account_departments ad
          ON ad.directory_account_id = a.id
        JOIN allowed_departments scoped
          ON scoped.id = ad.directory_department_id
        WHERE l.local_user_id = $3
          AND l.link_status = 'linked'
        UNION
        SELECT 1
        FROM platform_member_group_members gm
        JOIN allowed_groups scoped_groups
          ON scoped_groups.group_id = gm.group_id
        WHERE gm.user_id = $3
      ) AS allowed`,
    [adminUserId, namespaces, userId],
  )

  return result.rows[0]?.allowed === true
}
