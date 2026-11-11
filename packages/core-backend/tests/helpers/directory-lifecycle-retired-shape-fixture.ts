/**
 * Retired-shape fixture for directory-integration lifecycle history tests.
 *
 * The "retired shape" of an integration is: the integration row is kept with `status = 'retired'`
 * and `sync_enabled = false`; its directory accounts and departments are inactive; nothing else
 * is written (no link, user, membership, identity or grant row changes). This module builds the
 * shape with plain SQL so the same readers can be exercised against it, and so the active
 * counterpart of every fixture row is one switch away.
 *
 * Every identifier carries the caller's run tag and every organisation id is unique per run, so
 * the rows of one run are never selected by another file's organisation-scoped queries.
 */

export type QueryFn = (
  sql: string,
  params?: unknown[],
) => Promise<{ rows: any[]; rowCount?: number | null }>

export type FixtureIntegration = {
  id: string
  orgId: string
  name: string
  corpId: string
}

export type FixtureAccount = {
  id: string
  integrationId: string
  externalUserId: string
  unionId: string
  name: string
}

export type FixtureDepartment = {
  id: string
  integrationId: string
  externalDepartmentId: string
  name: string
}

export const FIXTURE_UPDATED_AT = '2030-01-01T00:00:00.000Z'
/** Directory rows were last seen long before any run of the suite. */
export const FIXTURE_SEEN_AT = '2026-01-01T00:00:00.000Z'

export const RETIRED_SHAPE = Object.freeze({
  integrationStatus: 'retired',
  syncEnabled: false,
  accountsActive: false,
  departmentsActive: false,
})

export async function insertFixtureUser(
  query: QueryFn,
  input: {
    id: string
    email: string
    name: string
    mobile?: string | null
    isActive?: boolean
    activationStatus?: 'activated' | 'pending_activation'
    role?: 'user' | 'admin'
  },
): Promise<void> {
  await query(
    `INSERT INTO users (id, email, name, password_hash, role, is_admin, mobile, is_active, activation_status)
     VALUES ($1, $2, $3, 'x', $4, $5, $6, $7, $8)`,
    [
      input.id,
      input.email,
      input.name,
      input.role ?? 'user',
      input.role === 'admin',
      input.mobile ?? null,
      input.isActive ?? true,
      input.activationStatus ?? 'activated',
    ],
  )
}

export async function insertFixtureMembership(query: QueryFn, userId: string, orgId: string): Promise<void> {
  await query(`INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, TRUE)`, [userId, orgId])
}

export async function insertFixtureIntegration(
  query: QueryFn,
  input: {
    orgId: string
    name: string
    corpId: string
    config?: Record<string, unknown>
    updatedAt?: string
  },
): Promise<FixtureIntegration> {
  const result = await query(
    `INSERT INTO directory_integrations (org_id, provider, name, status, corp_id, config, sync_enabled, created_at, updated_at)
     VALUES ($1, 'dingtalk', $2, 'active', $3, $4::jsonb, false, $5::timestamptz, $5::timestamptz)
     RETURNING id::text AS id`,
    [
      input.orgId,
      input.name,
      input.corpId,
      JSON.stringify(input.config ?? { appKey: `${input.corpId}-key`, appSecret: `${input.corpId}-secret` }),
      input.updatedAt ?? FIXTURE_UPDATED_AT,
    ],
  )
  return { id: result.rows[0].id, orgId: input.orgId, name: input.name, corpId: input.corpId }
}

export async function insertFixtureDepartment(
  query: QueryFn,
  integration: FixtureIntegration,
  input: { externalDepartmentId: string; name: string; parentExternalId?: string | null; raw?: Record<string, unknown> },
): Promise<FixtureDepartment> {
  const result = await query(
    `INSERT INTO directory_departments (
       integration_id, provider, external_department_id, external_parent_department_id, name, full_path,
       order_index, is_active, raw, last_seen_at, created_at, updated_at
     ) VALUES ($1, 'dingtalk', $2, $3, $4, $4, 0, true, $5::jsonb, $6::timestamptz, $6::timestamptz, $6::timestamptz)
     RETURNING id::text AS id`,
    [
      integration.id,
      input.externalDepartmentId,
      input.parentExternalId ?? null,
      input.name,
      JSON.stringify(input.raw ?? {}),
      FIXTURE_SEEN_AT,
    ],
  )
  return {
    id: result.rows[0].id,
    integrationId: integration.id,
    externalDepartmentId: input.externalDepartmentId,
    name: input.name,
  }
}

export async function insertFixtureAccount(
  query: QueryFn,
  integration: FixtureIntegration,
  input: { externalUserId: string; name: string; email?: string | null; openId?: string | null },
): Promise<FixtureAccount> {
  const unionId = `${integration.corpId}:${input.externalUserId}`
  const result = await query(
    `INSERT INTO directory_accounts (
       integration_id, provider, corp_id, external_user_id, union_id, open_id, external_key,
       name, email, is_active, raw, last_seen_at, created_at, updated_at
     ) VALUES ($1, 'dingtalk', $2, $3, $4, $5, $4, $6, $7, true, '{}'::jsonb, $8::timestamptz, $8::timestamptz, $8::timestamptz)
     RETURNING id::text AS id`,
    [
      integration.id,
      integration.corpId,
      input.externalUserId,
      unionId,
      input.openId ?? null,
      input.name,
      input.email ?? null,
      FIXTURE_SEEN_AT,
    ],
  )
  return {
    id: result.rows[0].id,
    integrationId: integration.id,
    externalUserId: input.externalUserId,
    unionId,
    name: input.name,
  }
}

export async function linkFixtureAccount(
  query: QueryFn,
  accountId: string,
  localUserId: string | null,
  linkStatus: 'linked' | 'pending' | 'unmatched' | 'manual_unbound' = 'linked',
): Promise<void> {
  await query(
    `INSERT INTO directory_account_links (directory_account_id, local_user_id, link_status, match_strategy, created_at, updated_at)
     VALUES ($1::uuid, $2, $3, 'lc0_fixture', $4::timestamptz, $4::timestamptz)`,
    [accountId, localUserId, linkStatus, FIXTURE_SEEN_AT],
  )
}

export async function attachFixtureAccountToDepartment(
  query: QueryFn,
  accountId: string,
  departmentId: string,
  isPrimary = true,
): Promise<void> {
  await query(
    `INSERT INTO directory_account_departments (directory_account_id, directory_department_id, is_primary)
     VALUES ($1::uuid, $2::uuid, $3)`,
    [accountId, departmentId, isPrimary],
  )
}

/**
 * Puts one integration into the retired shape. Only the integration row, its accounts and its
 * departments are written.
 */
export async function applyRetiredShape(query: QueryFn, integrationId: string): Promise<void> {
  await query(
    `UPDATE directory_integrations SET status = 'retired', sync_enabled = false WHERE id = $1::uuid`,
    [integrationId],
  )
  await query(`UPDATE directory_accounts SET is_active = false WHERE integration_id = $1::uuid`, [integrationId])
  await query(`UPDATE directory_departments SET is_active = false WHERE integration_id = $1::uuid`, [integrationId])
}

export async function readFixtureShape(
  query: QueryFn,
  integrationId: string,
): Promise<{ status: string; syncEnabled: boolean; activeAccounts: number; activeDepartments: number }> {
  const result = await query(
    `SELECT i.status, i.sync_enabled,
            (SELECT count(*)::int FROM directory_accounts a WHERE a.integration_id = i.id AND a.is_active) AS active_accounts,
            (SELECT count(*)::int FROM directory_departments d WHERE d.integration_id = i.id AND d.is_active) AS active_departments
       FROM directory_integrations i WHERE i.id = $1::uuid`,
    [integrationId],
  )
  const row = result.rows[0]
  return {
    status: row.status,
    syncEnabled: Boolean(row.sync_enabled),
    activeAccounts: Number(row.active_accounts),
    activeDepartments: Number(row.active_departments),
  }
}

/** Removes the rows of the given integrations and users (children first). */
export async function removeFixtureRows(
  query: QueryFn,
  input: { integrationIds: string[]; userIds: string[] },
): Promise<void> {
  if (input.integrationIds.length > 0) {
    await query(`DELETE FROM directory_integrations WHERE id = ANY($1::uuid[])`, [input.integrationIds])
  }
  if (input.userIds.length > 0) {
    await query(`DELETE FROM users WHERE id = ANY($1::text[])`, [input.userIds])
  }
}
