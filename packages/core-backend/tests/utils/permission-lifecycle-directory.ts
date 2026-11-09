import { query } from '../../src/db/pg'

export interface PermissionLifecycleDirectory {
  integrationId: string
  parentDepartmentId: string
  childDepartmentId: string
  outsideDepartmentId: string
}

type Queryable = {
  query: (sql: string, params?: unknown[]) => Promise<unknown>
}

export async function createPermissionLifecycleDirectory(runHex: string): Promise<PermissionLifecycleDirectory> {
  const integration = await query<{ id: string }>(
    `INSERT INTO directory_integrations (name, corp_id)
     VALUES ($1, $2)
     RETURNING id`,
    [`plc-${runHex}`, `plc-corp-${runHex}`],
  )
  const integrationId = integration.rows[0]?.id
  if (!integrationId) throw new Error('directory integration insert did not return an id')

  const parentExternalId = `plc-parent-${runHex}`
  const parent = await query<{ id: string }>(
    `INSERT INTO directory_departments
       (integration_id, external_department_id, name, is_active, raw)
     VALUES ($1, $2, $3, true, '{}'::jsonb)
     RETURNING id`,
    [integrationId, parentExternalId, `plc-parent-${runHex}`],
  )
  const parentDepartmentId = parent.rows[0]?.id
  if (!parentDepartmentId) throw new Error('parent department insert did not return an id')

  const child = await query<{ id: string }>(
    `INSERT INTO directory_departments
       (integration_id, external_department_id, external_parent_department_id, name, is_active, raw)
     VALUES ($1, $2, $3, $4, true, '{}'::jsonb)
     RETURNING id`,
    [integrationId, `plc-child-${runHex}`, parentExternalId, `plc-child-${runHex}`],
  )
  const childDepartmentId = child.rows[0]?.id
  if (!childDepartmentId) throw new Error('child department insert did not return an id')

  const outside = await query<{ id: string }>(
    `INSERT INTO directory_departments
       (integration_id, external_department_id, name, is_active, raw)
     VALUES ($1, $2, $3, true, '{}'::jsonb)
     RETURNING id`,
    [integrationId, `plc-outside-${runHex}`, `plc-outside-${runHex}`],
  )
  const outsideDepartmentId = outside.rows[0]?.id
  if (!outsideDepartmentId) throw new Error('outside department insert did not return an id')

  return { integrationId, parentDepartmentId, childDepartmentId, outsideDepartmentId }
}

export async function linkPermissionLifecycleDepartmentUser(
  directory: PermissionLifecycleDirectory,
  userId: string,
  departmentId: string,
): Promise<void> {
  const account = await query<{ id: string }>(
    `INSERT INTO directory_accounts
       (integration_id, external_user_id, external_key, name, is_active, raw)
     VALUES ($1, $2, $2, $3, true, '{}'::jsonb)
     RETURNING id`,
    [directory.integrationId, `plc-account-${userId}`, 'synthetic'],
  )
  const accountId = account.rows[0]?.id
  if (!accountId) throw new Error('directory account insert did not return an id')
  await query(
    `INSERT INTO directory_account_links
       (directory_account_id, local_user_id, link_status, match_strategy)
     VALUES ($1, $2, 'linked', 'manual')`,
    [accountId, userId],
  )
  await query(
    `INSERT INTO directory_account_departments
       (directory_account_id, directory_department_id, is_primary)
     VALUES ($1, $2, true)`,
    [accountId, departmentId],
  )
}

export async function deletePermissionLifecycleDirectory(
  db: Queryable,
  integrationId: string,
): Promise<void> {
  await db.query('DELETE FROM directory_integrations WHERE id = $1::uuid', [integrationId])
}
