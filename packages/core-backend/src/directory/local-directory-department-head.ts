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

export interface NativeDepartmentHeadRead {
  /** True only when this exact department row is local and belongs to the caller's integration. */
  localDepartment: boolean
  departmentId: string | null
  headId?: string
  externalDepartmentId: string | null
  parentExternalId: string | null
}

const EMPTY_NATIVE_DEPARTMENT: NativeDepartmentHeadRead = {
  localDepartment: false,
  departmentId: null,
  externalDepartmentId: null,
  parentExternalId: null,
}

interface NativeDepartmentHeadRow {
  department_id: string | null
  external_department_id: string | null
  external_parent_department_id: string | null
  department_provider: string | null
  department_integration_id: string | null
  integration_active: boolean | null
  department_active: boolean | null
  account_provider: string | null
  external_user_id: string | null
  local_user_id: string | null
}

function blankKey(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function mapNativeDepartmentHead(
  rows: NativeDepartmentHeadRow[],
  integrationId: string,
  requesterLocalId: string,
  expectedDepartmentId?: string,
): NativeDepartmentHeadRead {
  const row = rows[0]
  const departmentId = blankKey(row?.department_id)
  const departmentProvider = blankKey(row?.department_provider)
  const departmentIntegrationId = blankKey(row?.department_integration_id)
  if (!row || !departmentId || departmentProvider !== 'local' || departmentIntegrationId !== integrationId) {
    return EMPTY_NATIVE_DEPARTMENT
  }
  if (expectedDepartmentId && departmentId !== expectedDepartmentId) return EMPTY_NATIVE_DEPARTMENT
  if (rows.some((candidate) => blankKey(candidate.department_id) !== departmentId
    || blankKey(candidate.department_integration_id) !== integrationId
    || blankKey(candidate.department_provider) !== 'local')) {
    return EMPTY_NATIVE_DEPARTMENT
  }
  const head = rows.find((candidate) =>
    candidate.integration_active === true
    && candidate.department_active === true
    && blankKey(candidate.account_provider) === 'local'
    && candidate.local_user_id
    && candidate.local_user_id !== requesterLocalId)
  return {
    localDepartment: true,
    departmentId,
    externalDepartmentId: row.external_department_id,
    parentExternalId: row.external_parent_department_id,
    ...(head?.local_user_id ? { headId: head.local_user_id } : {}),
  }
}

const NATIVE_DEPARTMENT_HEAD_SELECT = `
  SELECT d.id::text AS department_id,
         d.external_department_id AS external_department_id,
         d.external_parent_department_id AS external_parent_department_id,
         d.provider AS department_provider,
         d.integration_id::text AS department_integration_id,
         (i.status = 'active' AND i.provider = 'local') AS integration_active,
         d.is_active AS department_active,
         a.provider AS account_provider,
         a.external_user_id AS external_user_id,
         CASE WHEN uo.user_id IS NOT NULL THEN u.id ELSE NULL END AS local_user_id
    FROM directory_departments d
    JOIN directory_integrations i
      ON i.id = d.integration_id
     AND i.id = $1::uuid
     AND i.provider = 'local'
    LEFT JOIN directory_account_departments ad
      ON ad.directory_department_id = d.id
     AND ad.is_department_head = true
    LEFT JOIN directory_accounts a
      ON a.id = ad.directory_account_id
     AND a.integration_id = d.integration_id
     AND a.provider = 'local'
     AND a.is_active = true
    LEFT JOIN directory_account_links l
      ON l.directory_account_id = a.id
     AND l.link_status = 'linked'
     AND l.local_user_id IS NOT NULL
    LEFT JOIN users u ON u.id = l.local_user_id AND u.is_active = true
    LEFT JOIN user_orgs uo
      ON uo.user_id = u.id AND uo.org_id = i.org_id AND uo.is_active = true`

/**
 * Native head for one exact department UUID. A blank or colliding external key never selects a
 * different row: the department id, local provider, and integration all have to match.
 */
export async function readNativeDepartmentHead(
  integrationId: string,
  departmentId: string,
  requesterLocalId: string,
  query: DirectoryQuery,
): Promise<NativeDepartmentHeadRead> {
  if (!blankKey(integrationId) || !blankKey(departmentId)) return EMPTY_NATIVE_DEPARTMENT
  const result = await query<NativeDepartmentHeadRow>(
    `${NATIVE_DEPARTMENT_HEAD_SELECT}
      WHERE d.id = $2::uuid
        AND d.integration_id = $1::uuid
        AND d.provider = 'local'
      ORDER BY a.external_user_id ASC, a.id ASC`,
    [integrationId, departmentId],
  )
  return mapNativeDepartmentHead(result.rows, integrationId, requesterLocalId, departmentId)
}

/**
 * Next parent in a verified local integration. The parent pointer is an external key, but only
 * inside this integration and only when that key is non-blank. This is not a fallback for the
 * requester's own department.
 */
export async function readNativeParentDepartmentHead(
  integrationId: string,
  parentExternalDepartmentId: string,
  requesterLocalId: string,
  query: DirectoryQuery,
): Promise<NativeDepartmentHeadRead> {
  const parentKey = blankKey(parentExternalDepartmentId)
  if (!blankKey(integrationId) || !parentKey) return EMPTY_NATIVE_DEPARTMENT
  const result = await query<NativeDepartmentHeadRow>(
    `${NATIVE_DEPARTMENT_HEAD_SELECT}
      WHERE d.integration_id = $1::uuid
        AND d.provider = 'local'
        AND d.external_department_id = $2
        AND btrim(d.external_department_id) <> ''
      ORDER BY a.external_user_id ASC, a.id ASC`,
    [integrationId, parentKey],
  )
  const read = mapNativeDepartmentHead(result.rows, integrationId, requesterLocalId)
  if (blankKey(read.externalDepartmentId) !== parentKey) return EMPTY_NATIVE_DEPARTMENT
  return read
}

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
