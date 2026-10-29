import { query as runQuery, transaction } from '../db/pg'

type MembershipIdentity = { directoryAccountId: string; directoryDepartmentId: string }

export type SetLocalMembershipDepartmentHeadResult =
  | { outcome: 'updated' }
  | { outcome: 'not_found' }
  | { outcome: 'archived' }

export interface LocalMembershipDepartmentHead {
  accountId: string
  departmentId: string
  isDepartmentHead: boolean
  readOnly: boolean
}

export async function getLocalMembershipDepartmentHead(
  orgId: string,
  identity: MembershipIdentity,
): Promise<LocalMembershipDepartmentHead | null> {
  const result = await runQuery<{
    account_id: string
    department_id: string
    is_department_head: boolean
    account_active: boolean
    department_active: boolean
  }>(
    `SELECT a.id::text AS account_id, d.id::text AS department_id,
            ad.is_department_head, a.is_active AS account_active, d.is_active AS department_active
       FROM directory_account_departments ad
       JOIN directory_accounts a ON a.id = ad.directory_account_id
       JOIN directory_integrations i ON i.id = a.integration_id
       JOIN directory_departments d ON d.id = ad.directory_department_id
      WHERE ad.directory_account_id = $1::uuid AND ad.directory_department_id = $2::uuid
        AND i.org_id = $3 AND i.provider = 'local' AND i.status = 'active'
        AND a.provider = 'local' AND d.provider = 'local'
        AND d.integration_id = a.integration_id`,
    [identity.directoryAccountId, identity.directoryDepartmentId, orgId.trim() || 'default'],
  )
  const row = result.rows[0]
  return row ? {
    accountId: row.account_id,
    departmentId: row.department_id,
    isDepartmentHead: row.is_department_head,
    readOnly: !row.account_active || !row.department_active,
  } : null
}

export async function setLocalMembershipDepartmentHead(
  orgId: string,
  identity: MembershipIdentity,
  enabled: boolean,
): Promise<SetLocalMembershipDepartmentHeadResult> {
  const normalizedOrgId = orgId.trim() || 'default'
  return await transaction(async (client) => {
    // Hold integration activity stable before account/department locks, including lock waits.
    const integration = await client.query(
      `SELECT i.id::text AS id
         FROM directory_integrations i
         JOIN directory_accounts a ON a.integration_id = i.id
         JOIN directory_account_departments ad ON ad.directory_account_id = a.id
        WHERE ad.directory_account_id = $1::uuid AND ad.directory_department_id = $2::uuid
          AND i.org_id = $3 AND i.provider = 'local' AND i.status = 'active'
          AND a.provider = 'local'
        FOR SHARE OF i`,
      [identity.directoryAccountId, identity.directoryDepartmentId, normalizedOrgId],
    )
    const integrationRow = integration.rows[0] as { id: string } | undefined
    if (!integrationRow) return { outcome: 'not_found' }

    // Match the existing local membership writer lock order: account, then department.
    const account = await client.query(
      `SELECT a.is_active
         FROM directory_account_departments ad
         JOIN directory_accounts a ON a.id = ad.directory_account_id
         JOIN directory_integrations i ON i.id = a.integration_id
        WHERE ad.directory_account_id = $1::uuid
          AND ad.directory_department_id = $2::uuid
          AND i.provider = 'local' AND i.status = 'active'
          AND a.provider = 'local' AND i.org_id = $3 AND a.integration_id = $4::uuid
        FOR UPDATE OF a`,
      [identity.directoryAccountId, identity.directoryDepartmentId, normalizedOrgId, integrationRow.id],
    )
    const accountRow = account.rows[0] as { is_active: boolean } | undefined
    if (!accountRow) return { outcome: 'not_found' }

    const department = await client.query(
      `SELECT d.is_active
         FROM directory_account_departments ad
         JOIN directory_accounts a ON a.id = ad.directory_account_id
         JOIN directory_departments d ON d.id = ad.directory_department_id
        WHERE ad.directory_account_id = $1::uuid
          AND ad.directory_department_id = $2::uuid
          AND d.integration_id = a.integration_id AND d.provider = 'local'
        FOR UPDATE OF d`,
      [identity.directoryAccountId, identity.directoryDepartmentId],
    )
    const departmentRow = department.rows[0] as { is_active: boolean } | undefined
    if (!departmentRow) return { outcome: 'not_found' }
    if (!accountRow.is_active || !departmentRow.is_active) return { outcome: 'archived' }

    await client.query(
      `UPDATE directory_account_departments SET is_department_head = $3
        WHERE directory_account_id = $1::uuid AND directory_department_id = $2::uuid`,
      [identity.directoryAccountId, identity.directoryDepartmentId, enabled],
    )
    return { outcome: 'updated' }
  })
}

type DirectoryQuery = <Row>(text: string, params?: unknown[]) => Promise<{ rows: Row[] }>

/** A local department is authoritative even if its configured head cannot be resolved. */
export async function resolveLocalDepartmentHead(
  integrationId: string,
  departmentExternalId: string,
  requesterLocalId: string,
  query: DirectoryQuery,
): Promise<{ localDepartment: boolean; headId?: string }> {
  const result = await query<{
    integration_active: boolean
    department_active: boolean | null
    account_id: string | null
    external_user_id: string | null
    local_user_id: string | null
  }>(
    `SELECT (i.status = 'active') AS integration_active, d.is_active AS department_active,
            a.id::text AS account_id, a.external_user_id,
            CASE WHEN uo.user_id IS NOT NULL THEN u.id ELSE NULL END AS local_user_id
       FROM directory_integrations i
       LEFT JOIN directory_departments d
         ON d.integration_id = i.id AND d.provider = 'local'
        AND d.external_department_id = $2
       LEFT JOIN directory_account_departments ad
         ON ad.directory_department_id = d.id AND ad.is_department_head = true
       LEFT JOIN directory_accounts a
         ON a.id = ad.directory_account_id AND a.integration_id = i.id
        AND a.provider = 'local' AND a.is_active = true
       LEFT JOIN directory_account_links l
         ON l.directory_account_id = a.id AND l.link_status = 'linked'
        AND l.local_user_id IS NOT NULL
       LEFT JOIN users u ON u.id = l.local_user_id AND u.is_active = true
       LEFT JOIN user_orgs uo
         ON uo.user_id = u.id AND uo.org_id = i.org_id AND uo.is_active = true
      WHERE i.id = $1::uuid AND i.provider = 'local'
      ORDER BY a.external_user_id ASC, a.id ASC`,
    [integrationId, departmentExternalId],
  )
  if (result.rows.length === 0) return { localDepartment: false }
  const head = result.rows.find(row =>
    row.integration_active === true && row.department_active === true
    && row.local_user_id && row.local_user_id !== requesterLocalId)
  return { localDepartment: true, ...(head?.local_user_id ? { headId: head.local_user_id } : {}) }
}
