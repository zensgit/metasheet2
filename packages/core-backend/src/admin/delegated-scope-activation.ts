import { createHash, randomUUID } from 'node:crypto'
import { deriveDelegatedAdminNamespace } from '../rbac/namespace-admission'

type Query = (sql: string, params?: unknown[]) => Promise<{ rows: readonly unknown[] }>

type ScopeActivation = {
  namespace: string
  enabled: boolean
  hasConfiguredScope: boolean
  version: string
}

export class DelegationActivationConflict extends Error {
  constructor(
    readonly code: 'ROLE_DELEGATION_ACTIVATION_CONFLICT' | 'ROLE_DELEGATION_ACTIVATION_SCOPE_REQUIRED',
  ) {
    super(code === 'ROLE_DELEGATION_ACTIVATION_CONFLICT'
      ? 'Delegation settings changed. Reload the management scope before applying this change.'
      : 'Configure a department or member group before enabling delegation.')
  }
}

export function isDelegatedScopeActivationEnabled(): boolean {
  return process.env.DELEGATED_SCOPE_ACTIVATION_ENABLED === 'true'
}

export function excludeDisabledDelegationNamespaces(
  namespaces: readonly string[],
  rows: readonly Record<string, unknown>[],
): string[] {
  const disabled = new Set(rows.filter((row) => row.enabled === false).map((row) => row.namespace))
  return namespaces.filter((namespace) => !disabled.has(namespace))
}

/** A stored stop is enforced even if the rollout no longer allows new state changes. */
export async function filterEnabledDelegationNamespaces(
  query: Query,
  userId: string,
  namespaces: readonly string[],
): Promise<string[]> {
  if (namespaces.length === 0) return []
  const { rows } = await query(
    `SELECT namespace, enabled
       FROM delegated_role_admin_activation
      WHERE admin_user_id = $1 AND namespace = ANY($2::text[])`,
    [userId, namespaces],
  )
  return excludeDisabledDelegationNamespaces(namespaces, rows as Record<string, unknown>[])
}

/** A configured group is selected by ID. Its members remain a live audience. */
async function hasConfiguredScope(query: Query, userId: string, namespace: string): Promise<boolean> {
  const { rows } = await query(
    `SELECT EXISTS (
       SELECT 1
         FROM delegated_role_admin_scopes s
         JOIN directory_departments d ON d.id = s.directory_department_id AND d.is_active
        WHERE s.admin_user_id = $1 AND s.namespace = $2
       UNION ALL
       SELECT 1 FROM delegated_role_admin_member_groups WHERE admin_user_id = $1 AND namespace = $2
     ) AS configured`,
    [userId, namespace],
  )
  return (rows[0] as { configured?: unknown } | undefined)?.configured === true
}

export async function readDelegationActivations(
  query: Query,
  actorId: string,
  userId: string,
  namespaces: readonly string[],
): Promise<ScopeActivation[]> {
  if (namespaces.length === 0) return []
  type ScopeActivationRow = {
    namespace: string
    enabled: boolean | null
    revision: string | null
    roles: [string, string][]
    departments: unknown[]
    groups: unknown[]
    configured: boolean
  }
  const { rows } = await query(
    `SELECT n.namespace, a.enabled, a.revision::text,
            COALESCE((SELECT jsonb_agg(jsonb_build_array(ur.role_id, extract(epoch FROM ur.created_at)::text) ORDER BY ur.role_id)
                        FROM user_roles ur WHERE ur.user_id = $1), '[]'::jsonb) AS roles,
            ARRAY(SELECT ROW(s.id, s.directory_department_id, s.include_children, extract(epoch FROM s.updated_at), d.is_active)::text
                    FROM delegated_role_admin_scopes s
                    JOIN directory_departments d ON d.id=s.directory_department_id
                   WHERE s.admin_user_id=$1 AND s.namespace=n.namespace ORDER BY s.id) AS departments,
            ARRAY(SELECT ROW(g.id, g.group_id, extract(epoch FROM g.updated_at))::text FROM delegated_role_admin_member_groups g
                   WHERE g.admin_user_id=$1 AND g.namespace=n.namespace ORDER BY g.id) AS groups,
            EXISTS (
              SELECT 1 FROM delegated_role_admin_scopes s
              JOIN directory_departments d ON d.id=s.directory_department_id AND d.is_active
              WHERE s.admin_user_id=$1 AND s.namespace=n.namespace
              UNION ALL
              SELECT 1 FROM delegated_role_admin_member_groups g WHERE g.admin_user_id=$1 AND g.namespace=n.namespace
            ) AS configured
       FROM unnest($2::text[]) n(namespace)
       LEFT JOIN delegated_role_admin_activation a ON a.admin_user_id=$1 AND a.namespace=n.namespace
      ORDER BY n.namespace`,
    [userId, namespaces],
  )
  return (rows as ScopeActivationRow[]).map((row) => ({
    namespace: row.namespace,
    enabled: row.enabled ?? row.configured,
    hasConfiguredScope: row.configured,
    version: `v1:${createHash('sha256').update(JSON.stringify([
      actorId, userId, row.namespace, row.enabled, row.revision,
      row.roles.filter(([roleId]) => deriveDelegatedAdminNamespace(roleId) === row.namespace),
      row.departments, row.groups,
    ])).digest('hex')}`,
  }))
}

/** Call under the subject's admission lock before mutating its configured audience. */
export async function initializeDelegationActivation(
  query: Query,
  userId: string,
  namespace: string,
): Promise<boolean> {
  const current = await query(
    'SELECT enabled FROM delegated_role_admin_activation WHERE admin_user_id=$1 AND namespace=$2',
    [userId, namespace],
  )
  const row = current.rows[0] as { enabled: boolean } | undefined
  if (row) return row.enabled
  if (!isDelegatedScopeActivationEnabled()) return false
  const enabled = await hasConfiguredScope(query, userId, namespace)
  const revision = randomUUID()
  const saved = await query(
    `INSERT INTO delegated_role_admin_activation (admin_user_id, namespace, enabled, revision)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (admin_user_id, namespace) DO NOTHING
     RETURNING enabled, revision::text`,
    [userId, namespace, enabled, revision],
  )
  requireSavedActivation(saved.rows, enabled, revision)
  return enabled
}

export async function assertConfiguredActiveDelegation(
  query: Query,
  userId: string,
  namespace: string,
  active: boolean,
): Promise<void> {
  if (active && !await hasConfiguredScope(query, userId, namespace)) {
    throw new DelegationActivationConflict('ROLE_DELEGATION_ACTIVATION_SCOPE_REQUIRED')
  }
}

function requireSavedActivation(rows: readonly unknown[], enabled: boolean, revision: string): void {
  const row = rows[0] as { enabled?: unknown; revision?: unknown } | undefined
  if (rows.length !== 1 || row?.enabled !== enabled || row.revision !== revision) {
    throw new Error('DELEGATED_SCOPE_ACTIVATION_WRITE_NOT_CONFIRMED')
  }
}

/** Caller rechecks role, actor, scope and expected version under the admission lock. */
export async function writeDelegationActivation(
  query: Query,
  userId: string,
  namespace: string,
  enabled: boolean,
): Promise<void> {
  const revision = randomUUID()
  const saved = await query(
    `INSERT INTO delegated_role_admin_activation (admin_user_id, namespace, enabled, revision)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (admin_user_id, namespace)
     DO UPDATE SET enabled = EXCLUDED.enabled, revision = EXCLUDED.revision
     RETURNING enabled, revision::text`,
    [userId, namespace, enabled, revision],
  )
  requireSavedActivation(saved.rows, enabled, revision)
}
