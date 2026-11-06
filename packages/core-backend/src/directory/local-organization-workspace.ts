import { transaction } from '../db/pg'

type Client = Parameters<Parameters<typeof transaction>[0]>[0]
type Anchor = { id: string; name: string; isActive: boolean }

export class LocalOrganizationWorkspaceError extends Error {
  constructor(public readonly status: 400 | 404 | 409, public readonly code: string, message: string) {
    super(message)
    this.name = 'LocalOrganizationWorkspaceError'
  }
}

export interface LocalOrganizationPage {
  integrationId: string
  page: number
  pageSize: number
  q: string
}

async function localAnchor(client: Client, orgId: string): Promise<Anchor | null> {
  const result = await (client.query(
    `SELECT id::text AS id, name, (status = 'active') AS is_active
       FROM directory_integrations
      WHERE org_id = $1 AND provider = 'local'
      ORDER BY (status = 'active') DESC, id ASC LIMIT 2`,
    [orgId],
  ) as Promise<{ rows: { id: string; name: string; is_active: boolean }[] }>)
  const active = result.rows.find(row => row.is_active === true)
  if (active) return { id: active.id, name: active.name, isActive: true }
  if (result.rows.length > 1) {
    throw new LocalOrganizationWorkspaceError(409, 'LOCAL_ORG_ANCHOR_AMBIGUOUS', 'Local organization anchor needs review')
  }
  const row = result.rows[0]
  return row ? { id: row.id, name: row.name, isActive: false } : null
}

async function readWorkspace<T>(
  orgId: string,
  work: (client: Client, anchor: Anchor | null) => Promise<T>,
): Promise<T> {
  return transaction(async client => {
    // The anchor, children and page counts share a snapshot; reads never bootstrap an anchor.
    await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    return work(client, await localAnchor(client, orgId))
  })
}

function requireAnchor(anchor: Anchor | null, expectedId: string): Anchor {
  if (!anchor || anchor.id !== expectedId) {
    throw new LocalOrganizationWorkspaceError(409, 'LOCAL_ORG_CONTEXT_CHANGED', 'Local organization context changed; refresh before continuing')
  }
  return anchor
}

export async function getLocalOrganizationWorkspace(orgId: string) {
  return readWorkspace(orgId, async (client, integration) => {
    if (!integration) return { integration: null, departments: [] }
    const result = await (client.query(
      `SELECT d.id::text AS id, d.name, parent.id::text AS parent_id,
              (d.external_parent_department_id IS NOT NULL AND parent.id IS NULL) AS parent_missing,
              d.order_index, d.is_active
         FROM directory_departments d
         LEFT JOIN directory_departments parent
           ON parent.integration_id = d.integration_id AND parent.provider = 'local'
          AND parent.external_department_id = d.external_parent_department_id
        WHERE d.integration_id = $1::uuid AND d.provider = 'local'
        ORDER BY d.order_index, d.name, d.id`,
      [integration.id],
    ) as Promise<{ rows: {
      id: string; name: string; parent_id: string | null; parent_missing: boolean
      order_index: number; is_active: boolean
    }[] }>)
    return {
      integration,
      departments: result.rows.map(row => ({
        id: row.id, name: row.name, parentDepartmentId: row.parent_id,
        parentMissing: row.parent_missing, orderIndex: row.order_index, isActive: row.is_active,
      })),
    }
  })
}

function searchPattern(q: string): string {
  return '%' + q.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_') + '%'
}

export async function listLocalOrganizationMembers(orgId: string, input: LocalOrganizationPage) {
  return readWorkspace(orgId, async (client, anchor) => {
    const integration = requireAnchor(anchor, input.integrationId)
    const params = [integration.id, input.q, searchPattern(input.q)]
    const from = `FROM directory_accounts a
      LEFT JOIN directory_account_links l ON l.directory_account_id = a.id
      LEFT JOIN users u ON u.id = l.local_user_id
      LEFT JOIN user_orgs uo ON uo.user_id = u.id AND uo.org_id = $4
     WHERE a.integration_id = $1::uuid AND a.provider = 'local'
       AND ($2 = '' OR a.name ILIKE $3 OR COALESCE(a.title, '') ILIKE $3
            OR COALESCE(u.name, '') ILIKE $3 OR COALESCE(u.username, '') ILIKE $3)`
    const values = [...params, orgId]
    const count = await (client.query('SELECT count(*)::int AS total ' + from, values) as Promise<{ rows: { total: number }[] }>)
    const result = await (client.query(
      `SELECT a.id::text AS id, a.name, a.title, a.is_active,
              CASE WHEN l.link_status = 'linked' THEN u.id ELSE NULL END AS user_id,
              CASE WHEN l.link_status = 'linked' THEN u.name ELSE NULL END AS user_name,
              CASE WHEN l.link_status = 'linked' THEN u.username ELSE NULL END AS username,
              COALESCE(l.link_status = 'linked' AND u.is_active = true AND uo.is_active = true, false) AS is_eligible,
              COALESCE((
                SELECT jsonb_agg(jsonb_build_object(
                  'id', a.id::text || ':' || d.id::text, 'departmentId', d.id::text,
                  'departmentName', d.name, 'departmentActive', d.is_active,
                  'isPrimary', ad.is_primary, 'isManager', ad.is_manager)
                  ORDER BY ad.is_primary DESC, d.order_index, d.name, d.id)
                  FROM directory_account_departments ad
                  JOIN directory_departments d ON d.id = ad.directory_department_id
                 WHERE ad.directory_account_id = a.id AND d.integration_id = a.integration_id
                   AND d.provider = 'local'
              ), '[]'::jsonb) AS memberships ` + from +
      ' ORDER BY a.is_active DESC, a.name, a.id LIMIT $5 OFFSET $6',
      [...values, input.pageSize, (input.page - 1) * input.pageSize],
    ) as Promise<{ rows: {
      id: string; name: string; title: string | null; is_active: boolean
      user_id: string | null; user_name: string | null; username: string | null
      is_eligible: boolean
      memberships: Array<{ id: string; departmentId: string; departmentName: string; departmentActive: boolean; isPrimary: boolean; isManager: boolean }>
    }[] }>)
    return {
      integrationId: integration.id, total: count.rows[0]?.total ?? 0,
      page: input.page, pageSize: input.pageSize,
      items: result.rows.map(row => ({
        id: row.id, name: row.name, title: row.title, isActive: row.is_active,
        localUser: row.user_id ? { id: row.user_id, name: row.user_name, username: row.username } : null,
        isEligible: row.is_eligible, memberships: row.memberships,
      })),
    }
  })
}

export async function listLocalOrganizationMemberCandidates(orgId: string, input: LocalOrganizationPage) {
  return readWorkspace(orgId, async (client, anchor) => {
    const integration = requireAnchor(anchor, input.integrationId)
    const from = `FROM users u JOIN user_orgs uo ON uo.user_id = u.id
     WHERE uo.org_id = $1 AND uo.is_active = true AND u.is_active = true
       AND NOT EXISTS (
         SELECT 1 FROM directory_accounts a
          WHERE (a.integration_id = $2::uuid
           AND (a.external_user_id = u.id OR a.external_key = $1 || ':' || u.id OR EXISTS (
             SELECT 1 FROM directory_account_links l
              WHERE l.directory_account_id = a.id AND l.local_user_id = u.id)))
             OR (a.provider = 'local' AND a.external_key = $1 || ':' || u.id)
       )
       AND NOT EXISTS (
         SELECT 1 FROM directory_deprovision_events e WHERE e.local_user_id = u.id AND e.status = 'applied'
       )
       AND NOT EXISTS (
         SELECT 1 FROM directory_deprovision_effects e WHERE e.local_user_id = u.id AND e.status = 'applied'
       )
       AND ($3 = '' OR COALESCE(u.name, '') ILIKE $4 OR COALESCE(u.username, '') ILIKE $4)`
    const values = [orgId, integration.id, input.q, searchPattern(input.q)]
    const count = await (client.query('SELECT count(*)::int AS total ' + from, values) as Promise<{ rows: { total: number }[] }>)
    const result = await (client.query(
      'SELECT u.id, u.name, u.username ' + from +
      ' ORDER BY COALESCE(u.name, u.username, \'\'), u.id LIMIT $5 OFFSET $6',
      [...values, input.pageSize, (input.page - 1) * input.pageSize],
    ) as Promise<{ rows: { id: string; name: string | null; username: string | null }[] }>)
    return { integrationId: integration.id, page: input.page, pageSize: input.pageSize, total: count.rows[0]?.total ?? 0, items: result.rows }
  })
}
