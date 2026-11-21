// Shared with the v2 journal migration to check the stored after-digest against
// current state before discarding legacy fields. Keep this snapshot format stable.
import { digest } from './handover-journal-v2'

export type Row = Record<string, unknown>
export type Client = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Row[] }>
}
export type Pair = { sourceIntegrationId: string; targetIntegrationId: string }
export type Snapshot = {
  integrations: Row[]
  accounts: Row[]
  departments: Row[]
  memberships: Row[]
  links: Row[]
  authority: Row[]
  cards: Row[]
  departmentBindings: Row[]
  dependencies: Row[]
}

async function jsonRows(
  c: Client,
  sql: string,
  args: unknown[],
): Promise<Row[]> {
  return (await c.query(sql, args)).rows.map((r) => r.row as Row)
}

export async function readHandoverSnapshot(
  c: Client,
  p: Pair,
): Promise<Snapshot> {
  const ids = [p.sourceIntegrationId, p.targetIntegrationId]
  const raw = await jsonRows(
    c,
    'SELECT to_jsonb(i) AS row FROM directory_integrations i WHERE id = ANY($1::uuid[]) ORDER BY id',
    [ids],
  )
  // The journal stores only a configuration fingerprint, never credentials or their ciphertext.
  const integrations = raw.map(({ config, ...row }) => ({
    ...row,
    configDigest: digest(config),
  }))
  const accounts = await jsonRows(
    c,
    'SELECT to_jsonb(a) AS row FROM directory_accounts a WHERE integration_id = ANY($1::uuid[]) ORDER BY id',
    [ids],
  )
  const departments = await jsonRows(
    c,
    'SELECT to_jsonb(d) AS row FROM directory_departments d WHERE integration_id = ANY($1::uuid[]) ORDER BY id',
    [ids],
  )
  const accountIds = accounts.map((a) => a.id)
  const memberships = await jsonRows(
    c,
    'SELECT to_jsonb(m) AS row FROM directory_account_departments m WHERE directory_account_id = ANY($1::uuid[]) ORDER BY directory_account_id,directory_department_id',
    [accountIds],
  )
  const links = await jsonRows(
    c,
    'SELECT to_jsonb(l) AS row FROM directory_account_links l WHERE directory_account_id = ANY($1::uuid[]) ORDER BY directory_account_id',
    [accountIds],
  )
  const users = links.filter((l) => l.local_user_id).map((l) => l.local_user_id)
  // Whole authority rows: stable permission/identity membership is part of the approval digest.
  const authority: Row[] = []
  for (const [table, key] of [
    ['users', 'id'],
    ['user_roles', 'user_id'],
    ['user_permissions', 'user_id'],
    ['user_orgs', 'user_id'],
    ['user_external_identities', 'local_user_id'],
    ['user_external_auth_grants', 'local_user_id'],
  ] as const) {
    const rows = await jsonRows(
      c,
      `SELECT to_jsonb(t) AS row FROM ${table} t WHERE ${key} = ANY($1::text[]) ORDER BY to_jsonb(t)::text`,
      [users],
    )
    // Login verification is expected between apply and finish. Ignore only login telemetry;
    // all structured identity keys, passwords, active flags, permissions and generations stay pinned.
    const pinned = rows.map((row) => {
      if (table !== 'users' && table !== 'user_external_identities') return row
      const { last_login_at: _login, updated_at: _updated, ...fields } = row
      if (table === 'user_external_identities') {
        const { profile: _profile, ...identity } = fields
        return identity
      }
      return fields
    })
    authority.push({ table, digest: digest(pinned) })
  }
  const rolePermissions = await jsonRows(
    c,
    `SELECT DISTINCT to_jsonb(rp) AS row FROM role_permissions rp
    JOIN user_roles ur ON ur.role_id=rp.role_id WHERE ur.user_id=ANY($1::text[]) ORDER BY row`,
    [users],
  )
  authority.push({ table: 'role_permissions', digest: digest(rolePermissions) })
  const cards = await jsonRows(
    c,
    `SELECT jsonb_build_object('id',d.id,'instance',jsonb_build_object('status',i.status),
      'instanceId',d.instance_id,'node',d.node_key,'epoch',d.entry_epoch,'state',d.card_state,'send',d.send_status) AS row
    FROM dingtalk_approval_card_deliveries d LEFT JOIN approval_instances i ON i.id=d.instance_id
    WHERE d.integration_id = ANY($1::uuid[]) ORDER BY d.id`,
    [ids],
  )
  const departmentBindings = await jsonRows(
    c,
    'SELECT to_jsonb(b) AS row FROM directory_department_bindings b WHERE remote_integration_id=ANY($1::uuid[]) ORDER BY id',
    [ids],
  )
  const dependencies: Row[] = []
  for (const [table, key] of [
    ['delegated_role_admin_scopes', 'directory_department_id'],
    ['delegated_role_scope_template_departments', 'directory_department_id'],
    ['elearning_admin_scopes', 'directory_department_id'],
    ['elearning_stats_daily', 'department_id'],
    ['elearning_export_jobs', 'department_id'],
  ]) {
    const rows = await jsonRows(
      c,
      `SELECT to_jsonb(t) AS row FROM ${table} t WHERE ${key}=ANY($1::uuid[]) ORDER BY to_jsonb(t)::text`,
      [departments.map((d) => d.id)],
    )
    dependencies.push(...rows.map((row) => ({ table, digest: digest(row) })))
  }
  const policies = await jsonRows(
    c,
    `SELECT to_jsonb(t) AS row FROM org_directory_routing_policy t
    WHERE canonical_integration_id=ANY($1::uuid[]) OR fallback_integration_id=ANY($1::uuid[]) ORDER BY id`,
    [ids],
  )
  dependencies.push(
    ...policies.map((row) => ({
      table: 'org_directory_routing_policy',
      digest: digest(row),
    })),
  )
  return {
    integrations,
    accounts,
    departments,
    memberships,
    links,
    authority,
    cards,
    departmentBindings,
    dependencies,
  }
}
