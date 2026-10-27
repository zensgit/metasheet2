import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { Client } from 'pg'
import { MetaSheetServer } from '../../src/index'
import { query } from '../../src/db/pg'
import { invalidateUserPerms } from '../../src/rbac/service'
import { setLocalMembershipManager } from '../../src/directory/directory-sync'
import {
  addLocalMembership,
  createLocalAccount,
  createLocalDepartment,
  switchLocalPrimaryDepartment,
} from '../../src/directory/local-directory-org'
import { resolveApprovalRequesterOrgRelations } from '../../src/services/ApprovalDirectoryOrg'

// Synthetic service fixtures, real HTTP/auth/PG. Migrations belong to the executing lane.
// No schema bootstrap, provider IO, enrollment-UX or full-UI acceptance is implied.
const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const itIfExpectDb = process.env.EXPECT_DB === '1' ? it : it.skip
itIfExpectDb('sentinel: EXPECT_DB lane must have DATABASE_URL', () => {
  expect(process.env.DATABASE_URL).toBeTruthy()
})

type Account = Awaited<ReturnType<typeof createLocalAccount>>
type Department = Awaited<ReturnType<typeof createLocalDepartment>>
type Fixture = {
  org: string
  integration: string
  department: Department
  requester: Account
  manager: Account
  head: Account
  next: Account
}
type Policy = {
  id: string; canonical_integration_id: string; fallback_integration_id: string | null
  created_at: string; updated_at: string
}

describeIfDatabase('native local department-head backend', () => {
  let server: MetaSheetServer | undefined
  let base = ''
  const previousEnv = new Map<string, string | undefined>()
  const users: string[] = []
  const accounts: string[] = []
  const departments: string[] = []
  const integrations: string[] = []
  const templates: string[] = []
  const instances: string[] = []
  const policies = new Map<string, Policy | null>()
  const tokens = new Map<string, string>()

  beforeAll(async () => {
    if (process.env.EXPECT_DB === '1') expect(process.env.DATABASE_URL).toBeTruthy()
    for (const key of ['RBAC_TOKEN_TRUST', 'RBAC_BYPASS']) {
      previousEnv.set(key, process.env[key])
      process.env[key] = 'false'
    }
    server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [] })
    await server.start()
    const address = server.getAddress()
    expect(address && typeof address === 'object' && address.port).toBeTruthy()
    base = `http://127.0.0.1:${address && typeof address === 'object' ? address.port : 0}`
  })

  afterEach(async () => {
    // Instances/templates precede identities. Only exact IDs owned by this test are removed.
    for (const id of instances.splice(0)) {
      for (const table of ['approval_records', 'approval_assignments', 'approval_metrics']) {
        await query(`DELETE FROM ${table} WHERE instance_id = $1`, [id])
      }
      await query('DELETE FROM approval_instances WHERE id = $1', [id])
    }
    for (const id of templates.splice(0)) {
      await query('DELETE FROM approval_published_definitions WHERE template_id = $1', [id])
      await query('DELETE FROM approval_template_versions WHERE template_id = $1', [id])
      await query('DELETE FROM approval_templates WHERE id = $1', [id])
    }
    for (const [org, previous] of policies) {
      if (previous) {
        await query(
          `UPDATE org_directory_routing_policy SET canonical_integration_id = $2,
             fallback_integration_id = $3, created_at = $4, updated_at = $5
           WHERE id = $1 AND org_id = $6 AND purpose = 'approval_routing'`,
          [previous.id, previous.canonical_integration_id, previous.fallback_integration_id,
            previous.created_at, previous.updated_at, org],
        )
      } else {
        await query("DELETE FROM org_directory_routing_policy WHERE org_id = $1 AND purpose = 'approval_routing'", [org])
      }
    }
    policies.clear()
    const resourceIds = [...accounts, ...departments, ...integrations,
      ...accounts.flatMap((account) => departments.map((department) => `${account}:${department}`))]
    await query('DELETE FROM audit_logs WHERE resource_id = ANY($1::text[])', [resourceIds])
    await query('DELETE FROM directory_account_departments WHERE directory_account_id = ANY($1::uuid[])', [accounts])
    await query('DELETE FROM directory_account_links WHERE directory_account_id = ANY($1::uuid[])', [accounts])
    await query('DELETE FROM directory_accounts WHERE id = ANY($1::uuid[])', [accounts.splice(0)])
    await query('DELETE FROM directory_departments WHERE id = ANY($1::uuid[])', [departments.splice(0)])
    await query('DELETE FROM directory_integrations WHERE id = ANY($1::uuid[])', [integrations.splice(0)])
    for (const table of ['user_sessions', 'user_permissions', 'user_roles', 'user_orgs']) {
      await query(`DELETE FROM ${table} WHERE user_id = ANY($1::text[])`, [users])
    }
    await query('DELETE FROM users WHERE id = ANY($1::text[])', [users])
    for (const id of users.splice(0)) invalidateUserPerms(id)
    tokens.clear()
  })

  afterAll(async () => {
    try {
      await server?.stop()
    } finally {
      for (const [key, value] of previousEnv) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })

  async function user(admin = false): Promise<string> {
    const id = `local-head-${randomUUID()}`
    users.push(id)
    await query(
      `INSERT INTO users (id, email, username, name, password_hash, role, permissions,
         is_active, is_admin, activation_status, local_password_set, must_change_password)
       VALUES ($1, $1 || '@example.test', $1, $1, 'x', $2, '[]'::jsonb,
         TRUE, $3, 'activated', TRUE, FALSE)`, [id, admin ? 'admin' : 'user', admin],
    )
    if (admin) await query('INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, TRUE)', [id, 'default'])
    return id
  }

  async function token(id: string): Promise<string> {
    if (tokens.has(id)) return tokens.get(id)!
    const response = await fetch(`${base}/api/auth/dev-token?userId=${encodeURIComponent(id)}&roles=user&perms=`)
    expect(response.status).toBe(200)
    const body = await response.json() as {
      token: string; payload: { roles: string[]; perms: string[]; sid: string }
    }
    expect(body.payload.roles).toEqual(['user'])
    expect(body.payload.perms).toEqual([])
    expect((await query('SELECT id FROM user_sessions WHERE user_id = $1 AND revoked_at IS NULL', [id])).rows)
      .toEqual([{ id: body.payload.sid }])
    tokens.set(id, body.token)
    return body.token
  }

  async function request(path: string, actor: string, method = 'GET', body?: unknown): Promise<Response> {
    return fetch(`${base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${await token(actor)}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  }

  async function policy(org: string, integration: string): Promise<void> {
    if (!policies.has(org)) {
      const previous = await query<Policy>(
        "SELECT id, canonical_integration_id, fallback_integration_id, created_at::text AS created_at, updated_at::text AS updated_at FROM org_directory_routing_policy WHERE org_id = $1 AND purpose = 'approval_routing'", [org],
      )
      policies.set(org, previous.rows[0] ?? null)
    }
    await query(
      `INSERT INTO org_directory_routing_policy (org_id, purpose, canonical_integration_id)
       VALUES ($1, 'approval_routing', $2) ON CONFLICT ON CONSTRAINT orp_org_purpose_uniq
       DO UPDATE SET canonical_integration_id = EXCLUDED.canonical_integration_id`, [org, integration],
    )
  }

  async function department(org: string, parent?: Department): Promise<Department> {
    const row = await createLocalDepartment({
      orgId: org, name: `Department ${randomUUID()}`, parentDepartmentId: parent?.id,
    })
    departments.push(row.id)
    return row
  }

  async function account(org: string, id = ''): Promise<Account> {
    const row = await createLocalAccount({ orgId: org, localUserId: id || await user() })
    accounts.push(row.id)
    return row
  }

  async function member(a: Account, d: Department, org: string): Promise<void> {
    await addLocalMembership({ orgId: org, accountId: a.id, departmentId: d.id })
  }

  async function fixture(org = `local-head-org-${randomUUID()}`, requesterId = ''): Promise<Fixture> {
    if (org === 'default') {
      const anchors = await query<{ status: string }>(
        "SELECT status FROM directory_integrations WHERE org_id = $1 AND provider = 'local'", [org],
      )
      if (anchors.rows.length > 0 && !anchors.rows.some(row => row.status === 'active')) {
        throw new Error('Native head fixture requires an active default local anchor')
      }
    }
    // createLocalAccount is intentional fixture provisioning; HTTP enrollment guard is unchanged.
    const requester = await account(org, requesterId)
    const manager = await account(org)
    const head = await account(org)
    const next = await account(org)
    const d = await department(org)
    for (const a of [requester, manager, head, next]) await member(a, d, org)
    await switchLocalPrimaryDepartment(org, requester.id, d.id)
    expect(await setLocalMembershipManager(org, {
      directoryAccountId: manager.id, directoryDepartmentId: d.id,
    }, true)).toEqual({ outcome: 'updated' })
    const row = await query<{ integration_id: string }>('SELECT integration_id FROM directory_accounts WHERE id = $1', [requester.id])
    const integration = row.rows[0].integration_id
    if (org !== 'default') integrations.push(integration) // never own/delete the canonical default anchor
    await policy(org, integration)
    return { org, integration, department: d, requester, manager, head, next }
  }

  async function seedHead(a: Account, d: Department, enabled = true): Promise<void> {
    // Baseline uses ONLY the newly migrated legal boolean column and existing native resolver.
    const result = await query(
      'UPDATE directory_account_departments SET is_department_head = $3 WHERE directory_account_id = $1 AND directory_department_id = $2 RETURNING is_department_head',
      [a.id, d.id, enabled],
    )
    expect(result.rows).toEqual([{ is_department_head: enabled }])
  }

  function resolve(f: Fixture, maxLevels?: number) {
    return resolveApprovalRequesterOrgRelations(f.requester.localUserId!, query, {
      orgId: f.org, includeDeptHeadChain: true, maxLevels,
    })
  }

  function route(a: { id: string }, d: { id: string }) {
    return `/api/admin/directory/local/memberships/${a.id}:${d.id}/department-head`
  }

  function payload(a: Account, d: Department, enabled: boolean, readOnly?: boolean) {
    return { ok: true, data: { membership: {
      id: `${a.id}:${d.id}`, accountId: a.id, departmentId: d.id, isDepartmentHead: enabled,
      ...(readOnly === undefined ? {} : { readOnly }),
    } } }
  }

  async function snapshot() {
    const result = await query(
      `SELECT
         (SELECT jsonb_agg(to_jsonb(x) ORDER BY x.directory_account_id, x.directory_department_id)
            FROM directory_account_departments x WHERE directory_account_id = ANY($1::uuid[])) AS memberships,
         (SELECT jsonb_agg(to_jsonb(x) ORDER BY x.id) FROM directory_accounts x WHERE id = ANY($1::uuid[])) AS accounts,
         (SELECT jsonb_agg(to_jsonb(x) ORDER BY x.id) FROM directory_departments x WHERE id = ANY($2::uuid[])) AS departments,
         (SELECT jsonb_agg(to_jsonb(x) ORDER BY x.directory_account_id) FROM directory_account_links x
            WHERE directory_account_id = ANY($1::uuid[])) AS links,
         (SELECT jsonb_agg(to_jsonb(x) ORDER BY x.user_id, x.org_id) FROM user_orgs x WHERE user_id = ANY($3::text[])) AS orgs`,
      [accounts, departments, users],
    )
    return result.rows[0]
  }

  async function error(response: Response, status: number, code: string): Promise<void> {
    expect(response.status).toBe(status)
    const body = await response.json() as { ok: boolean; error: { code: string; message: string } }
    expect(body.ok).toBe(false)
    expect(body.error.code).toBe(code)
    expect(typeof body.error.message).toBe('string')
    for (const id of [...users, ...accounts, ...departments]) expect(JSON.stringify(body)).not.toContain(id)
  }

  it('LOCAL_HEAD_BASELINE: legal native head flag resolves the distinct head person', async () => {
    const f = await fixture()
    await seedHead(f.head, f.department)
    const rel = await resolve(f)
    expect(rel.deptHeadId).toBe(f.head.localUserId)
    expect(rel.managerId).toBe(f.manager.localUserId)
    expect(rel.deptHeadChainIds).toEqual([f.head.localUserId])
  })

  it('OLD_DIRECT_MANAGER_CONTROL: existing native direct manager on a valid organization', async () => {
    const f = await fixture()
    const rel = await resolve(f)
    expect(rel.managerId).toBe(f.manager.localUserId)
    expect(rel.deptHeadId).toBeUndefined()
  })

  it('local no-head is authoritative even with a resolvable poisoned provider raw list', async () => {
    const f = await fixture()
    await query('UPDATE directory_departments SET raw = $2::jsonb WHERE id = $1',
      [f.department.id, JSON.stringify({ dept_manager_userid_list: [f.next.externalUserId] })])
    expect((await resolve(f)).deptHeadId).toBeUndefined()
    expect((await resolve(f)).deptHeadChainIds).toBeUndefined()
    await seedHead(f.head, f.department)
    expect((await resolve(f)).deptHeadId).toBe(f.head.localUserId)
    await seedHead(f.head, f.department, false)
    expect((await resolve(f)).deptHeadId).toBeUndefined()
    expect((await resolve(f)).managerId).toBe(f.manager.localUserId)
    await seedHead(f.head, f.department)
    await query('UPDATE directory_departments SET is_active = FALSE WHERE id = $1', [f.department.id])
    expect((await resolve(f)).deptHeadId).toBeUndefined()
    expect((await resolve(f)).deptHeadChainIds).toBeUndefined()
    await query('UPDATE directory_departments SET is_active = TRUE WHERE id = $1', [f.department.id])
    expect((await resolve(f)).deptHeadId).toBe(f.head.localUserId)
    // Without a policy, the existing requester SELECT still picks this local integration.
    // A policy pointing at a disabled integration retains its separate configuration-error gate.
    await query("DELETE FROM org_directory_routing_policy WHERE org_id = $1 AND purpose = 'approval_routing'", [f.org])
    await query("UPDATE directory_integrations SET status = 'disabled' WHERE id = $1", [f.integration])
    expect((await resolve(f)).deptHeadId).toBeUndefined()
    expect((await resolve(f)).deptHeadChainIds).toBeUndefined()
    await query("UPDATE directory_integrations SET status = 'active' WHERE id = $1", [f.integration])
    expect((await resolve(f)).deptHeadId).toBe(f.head.localUserId)
    await query('DELETE FROM directory_departments WHERE id = $1', [f.department.id])
    expect((await resolve(f)).deptHeadId).toBeUndefined()
    expect((await resolve(f)).deptHeadChainIds).toBeUndefined()
  })

  it('head chain walks parents past an empty level and deduplicates local people', async () => {
    const f = await fixture()
    const top = await department(f.org)
    const middle = await department(f.org, top)
    await query('UPDATE directory_departments SET external_parent_department_id = $2 WHERE id = $1',
      [f.department.id, middle.externalDepartmentId])
    await member(f.next, top, f.org)
    await seedHead(f.head, f.department)
    await seedHead(f.next, top)
    expect((await resolve(f)).deptHeadChainIds).toEqual([f.head.localUserId, f.next.localUserId])
    await member(f.head, middle, f.org)
    await seedHead(f.head, middle)
    expect((await resolve(f)).deptHeadChainIds).toEqual([f.head.localUserId, f.next.localUserId])
  })

  it('head chain obeys depth cap and stops on a legacy cyclic parent pointer', async () => {
    const f = await fixture()
    const parent = await department(f.org)
    await member(f.next, parent, f.org)
    await seedHead(f.head, f.department)
    await seedHead(f.next, parent)
    // Legacy malformed owned rows only; no protected constraint is disabled.
    await query('UPDATE directory_departments SET external_parent_department_id = $2 WHERE id = $1',
      [f.department.id, parent.externalDepartmentId])
    await query('UPDATE directory_departments SET external_parent_department_id = $2 WHERE id = $1',
      [parent.id, f.department.externalDepartmentId])
    expect((await resolve(f, 1)).deptHeadChainIds).toEqual([f.head.localUserId])
    let parentReads = 0
    const countedQuery = async <Row>(sql: string, params?: unknown[]) => {
      if (sql.includes('external_parent_department_id')) parentReads += 1
      return { rows: (await query(sql, params)).rows as Row[] }
    }
    const rel = await resolveApprovalRequesterOrgRelations(f.requester.localUserId!, countedQuery, {
      orgId: f.org, includeDeptHeadChain: true, maxLevels: 10,
    })
    expect(rel.deptHeadChainIds).toEqual([f.head.localUserId, f.next.localUserId])
    expect(parentReads).toBe(2)
  })

  it('self and alias accounts are excluded; eligible flags use stable external-ID order', async () => {
    const f = await fixture()
    const alias = await query<{ id: string }>(
      `INSERT INTO directory_accounts (integration_id, provider, external_user_id, external_key, name, is_active, raw, updated_at)
       VALUES ($1, 'local', '000-alias', $2, 'Alias', TRUE, '{}'::jsonb, NOW() - interval '2 days') RETURNING id`,
      [f.integration, `alias-${randomUUID()}`],
    )
    const aliasId = alias.rows[0].id
    accounts.push(aliasId)
    await query("INSERT INTO directory_account_links (directory_account_id, local_user_id, link_status, match_strategy) VALUES ($1, $2, 'linked', 'manual')", [aliasId, f.requester.localUserId])
    await query('INSERT INTO directory_account_departments (directory_account_id, directory_department_id, is_department_head) VALUES ($1, $2, TRUE)', [aliasId, f.department.id])
    // Keep the existing requester-anchor selection on its primary-department account;
    // the older alias remains a head candidate and must still be excluded by local user ID.
    expect((await query(
      `SELECT a.id FROM directory_account_links l JOIN directory_accounts a ON a.id = l.directory_account_id
        WHERE l.local_user_id = $1 AND l.link_status = 'linked' AND a.integration_id = $2
        ORDER BY a.updated_at DESC, a.id ASC LIMIT 1`, [f.requester.localUserId, f.integration],
    )).rows).toEqual([{ id: f.requester.id }])
    await seedHead(f.requester, f.department)
    await seedHead(f.head, f.department)
    await seedHead(f.next, f.department)
    await query("UPDATE directory_accounts SET external_user_id = '100-head', updated_at = NOW() - interval '1 day' WHERE id = $1", [f.head.id])
    await query("UPDATE directory_accounts SET external_user_id = '200-next', updated_at = NOW() + interval '1 day' WHERE id = $1", [f.next.id])
    expect((await resolve(f)).deptHeadId).toBe(f.head.localUserId)
    expect((await resolve(f)).deptHeadChainIds).toEqual([f.head.localUserId])
    await seedHead(f.head, f.department, false)
    await seedHead(f.next, f.department, false)
    expect((await resolve(f)).deptHeadId).toBeUndefined()
    expect((await resolve(f)).deptHeadChainIds).toBeUndefined()
  })

  it('unlinked, inactive account/user, and lost active same-org membership are ineligible with restored controls', async () => {
    const f = await fixture()
    await seedHead(f.head, f.department)
    // A foreign active membership must not replace a lost membership in the routed organization.
    await query('INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, TRUE)',
      [f.head.localUserId, `foreign-head-org-${randomUUID()}`])
    const stages: Array<[string, string, string]> = [
      ["UPDATE directory_account_links SET link_status = 'unlinked' WHERE directory_account_id = $1", "UPDATE directory_account_links SET link_status = 'linked' WHERE directory_account_id = $1", f.head.id],
      ['UPDATE directory_accounts SET is_active = FALSE WHERE id = $1', 'UPDATE directory_accounts SET is_active = TRUE WHERE id = $1', f.head.id],
      ['UPDATE users SET is_active = FALSE WHERE id = $1', 'UPDATE users SET is_active = TRUE WHERE id = $1', f.head.localUserId!],
      ['UPDATE user_orgs SET is_active = FALSE WHERE user_id = $1 AND org_id = $2', 'UPDATE user_orgs SET is_active = TRUE WHERE user_id = $1 AND org_id = $2', f.head.localUserId!],
    ]
    for (const [disable, restore, id] of stages) {
      expect((await resolve(f)).deptHeadId).toBe(f.head.localUserId)
      const params = disable.includes('org_id') ? [id, f.org] : [id]
      await query(disable!, params)
      expect((await resolve(f)).deptHeadId).toBeUndefined()
      expect((await resolve(f)).deptHeadChainIds).toBeUndefined()
      await query(restore!, params)
      expect((await resolve(f)).deptHeadId).toBe(f.head.localUserId)
    }
  })

  it('same user in A/B and repeated department external IDs cannot borrow another integration or provider', async () => {
    const a = await fixture()
    const b = await fixture(undefined, a.requester.localUserId!)
    await query('UPDATE directory_departments SET external_department_id = $2 WHERE id = $1',
      [b.department.id, a.department.externalDepartmentId])
    await seedHead(a.head, a.department)
    await seedHead(b.head, b.department)
    expect((await resolve(a)).deptHeadId).toBe(a.head.localUserId)
    expect((await resolve(b)).deptHeadId).toBe(b.head.localUserId)
    await seedHead(a.head, a.department, false)
    // A legal-FK but cross-integration membership must not become A's head.
    await query('INSERT INTO directory_account_departments (directory_account_id, directory_department_id, is_department_head) VALUES ($1, $2, TRUE)', [b.head.id, a.department.id])
    expect((await resolve(a)).deptHeadId).toBeUndefined()
    expect((await resolve(b)).deptHeadId).toBe(b.head.localUserId)
    await seedHead(a.head, a.department)
    for (const table of ['directory_accounts', 'directory_departments']) {
      const id = table === 'directory_accounts' ? a.head.id : a.department.id
      await query(`UPDATE ${table} SET provider = 'dingtalk' WHERE id = $1`, [id])
      expect((await resolve(a)).deptHeadId).toBeUndefined()
      await query(`UPDATE ${table} SET provider = 'local' WHERE id = $1`, [id])
      expect((await resolve(a)).deptHeadId).toBe(a.head.localUserId)
    }
  })

  it('DingTalk retains its original raw-list order with no provider IO or token', async () => {
    const f = await fixture()
    await query("UPDATE directory_integrations SET provider = 'dingtalk', corp_id = $2 WHERE id = $1", [f.integration, `synthetic-${randomUUID()}`])
    await query("UPDATE directory_accounts SET provider = 'dingtalk' WHERE id = ANY($1::uuid[])", [[f.requester.id, f.manager.id, f.head.id, f.next.id]])
    await query("UPDATE directory_departments SET provider = 'dingtalk', raw = $2::jsonb WHERE id = $1",
      [f.department.id, JSON.stringify({ dept_manager_userid_list: [f.next.externalUserId, f.head.externalUserId] })])
    expect((await resolve(f)).deptHeadId).toBe(f.next.localUserId)
    expect((await resolve(f)).deptHeadChainIds).toEqual([f.next.localUserId])
  })

  it('admin set/get/unset changes only the head bit; direct-manager, primary, raw and access graph stay exact', async () => {
    const f = await fixture('default')
    const admin = await user(true)
    const before = await snapshot()
    expect(await (await request(route(f.head, f.department), admin)).json()).toEqual(payload(f.head, f.department, false, false))
    const set = await request(route(f.head, f.department), admin, 'PATCH', { isDepartmentHead: true })
    expect(set.status).toBe(200)
    expect(await set.json()).toEqual(payload(f.head, f.department, true))
    expect(await (await request(route(f.head, f.department), admin)).json()).toEqual(payload(f.head, f.department, true, false))
    expect((await resolve(f)).deptHeadId).toBe(f.head.localUserId)
    expect((await resolve(f)).managerId).toBe(f.manager.localUserId)
    const unset = await request(route(f.head, f.department), admin, 'PATCH', { isDepartmentHead: false })
    expect(unset.status).toBe(200)
    expect(await unset.json()).toEqual(payload(f.head, f.department, false))
    expect(await (await request(route(f.head, f.department), admin)).json()).toEqual(payload(f.head, f.department, false, false))
    expect(await snapshot()).toEqual(before)
    expect((await query(
      "SELECT action, action_details FROM audit_logs WHERE resource_type = 'directory-membership' AND resource_id = $1 AND action = 'directory.local_membership.set_department_head' ORDER BY id",
      [`${f.head.id}:${f.department.id}`],
    )).rows).toEqual([
      { action: 'directory.local_membership.set_department_head', action_details: { isDepartmentHead: true } },
      { action: 'directory.local_membership.set_department_head', action_details: { isDepartmentHead: false } },
    ])
    const oldDoor = await request(`/api/admin/directory/local/memberships/${f.head.id}:${f.department.id}`, admin, 'PATCH', { isDepartmentHead: true })
    await error(oldDoor, 400, 'DIRECTORY_LOCAL_UNKNOWN_FIELDS')
    expect(await snapshot()).toEqual(before)
  })

  it('strict boolean, unknown/org/corp fields and malformed UUIDs reject before any write', async () => {
    const f = await fixture('default')
    const admin = await user(true)
    const before = await snapshot()
    for (const body of [{}, { isDepartmentHead: 'true' }, { isDepartmentHead: 1 }, { isDepartmentHead: null }, { isDepartmentHead: [] }]) {
      await error(await request(route(f.head, f.department), admin, 'PATCH', body), 400, 'DIRECTORY_LOCAL_INVALID_INPUT')
    }
    for (const key of ['unknown', 'org_id', 'orgId', 'corp_id', 'corpId', 'isManager', 'isPrimary']) {
      await error(await request(route(f.head, f.department), admin, 'PATCH', { isDepartmentHead: true, [key]: 'synthetic' }), 400, 'DIRECTORY_LOCAL_UNKNOWN_FIELDS')
    }
    for (const id of ['bad', `bad:${f.department.id}`, `${f.head.id}:bad`, `${f.head.id}:${f.department.id}:extra`]) {
      for (const method of ['GET', 'PATCH']) {
        await error(await request(`/api/admin/directory/local/memberships/${id}/department-head`, admin, method,
          method === 'PATCH' ? { isDepartmentHead: true } : undefined), 400, 'DIRECTORY_LOCAL_INVALID_INPUT')
      }
    }
    expect(await snapshot()).toEqual(before)
  })

  it('ordinary DB user with claim-free real session is 403 for both admin doors', async () => {
    const f = await fixture('default')
    const id = f.requester.localUserId!
    expect((await query('SELECT role, is_admin, permissions FROM users WHERE id = $1', [id])).rows)
      .toEqual([{ role: 'user', is_admin: false, permissions: [] }])
    expect((await query('SELECT role_id FROM user_roles WHERE user_id = $1', [id])).rows).toEqual([])
    const before = await snapshot()
    for (const method of ['GET', 'PATCH']) {
      await error(await request(route(f.head, f.department), id, method,
        method === 'PATCH' ? { isDepartmentHead: true } : undefined), 403, 'FORBIDDEN')
    }
    expect(await snapshot()).toEqual(before)
  })

  it('foreign org, wrong integration/provider, disabled integration and missing membership are 404 with exact no-op snapshots', async () => {
    const f = await fixture('default')
    const foreign = await fixture()
    const admin = await user(true)
    async function refused(a: { id: string }, d: { id: string }) {
      const before = await snapshot()
      for (const method of ['GET', 'PATCH']) {
        await error(await request(route(a, d), admin, method,
          method === 'PATCH' ? { isDepartmentHead: true } : undefined), 404, 'DIRECTORY_LOCAL_NOT_FOUND')
      }
      expect(await snapshot()).toEqual(before)
    }
    await refused(foreign.head, foreign.department)
    await query('INSERT INTO directory_account_departments (directory_account_id, directory_department_id) VALUES ($1, $2)', [f.head.id, foreign.department.id])
    await refused(f.head, foreign.department)
    // Same-org owned integration: children stay local to isolate integration provider/status.
    // A disabled local anchor is legal; the uniqueness constraint covers ACTIVE local anchors only.
    const scoped = (await query<{ id: string }>(
      `INSERT INTO directory_integrations (org_id, provider, name, status, corp_id, config)
       VALUES ($1, 'dingtalk', $2, 'active', $2, '{}'::jsonb) RETURNING id`,
      [f.org, `head-negative-${randomUUID()}`],
    )).rows[0]!
    integrations.push(scoped.id)
    const scopedAccount = (await query<{ id: string }>(
      `INSERT INTO directory_accounts (integration_id, provider, external_user_id, external_key, name, raw)
       VALUES ($1, 'local', $2, $2, 'Synthetic negative', '{}'::jsonb) RETURNING id`,
      [scoped.id, randomUUID()],
    )).rows[0]!
    accounts.push(scopedAccount.id)
    const scopedDepartment = (await query<{ id: string }>(
      `INSERT INTO directory_departments (integration_id, provider, external_department_id, name, raw)
       VALUES ($1, 'local', $2, 'Synthetic negative', '{}'::jsonb) RETURNING id`,
      [scoped.id, f.department.externalDepartmentId],
    )).rows[0]!
    departments.push(scopedDepartment.id)
    await query('INSERT INTO directory_account_departments (directory_account_id, directory_department_id) VALUES ($1, $2)',
      [scopedAccount.id, scopedDepartment.id])
    await refused(scopedAccount, scopedDepartment)
    await query("UPDATE directory_integrations SET provider = 'local', status = 'disabled', corp_id = 'local:' || org_id WHERE id = $1", [scoped.id])
    await refused(scopedAccount, scopedDepartment)
    const empty = await department(f.org)
    await refused(f.head, empty)
    for (const [table, id] of [['directory_accounts', f.head.id], ['directory_departments', f.department.id]]) {
      await query(`UPDATE ${table} SET provider = 'dingtalk' WHERE id = $1`, [id])
      await refused(f.head, f.department)
      await query(`UPDATE ${table} SET provider = 'local' WHERE id = $1`, [id])
    }
  })

  it('archived account or department reads readOnly and refuses PATCH 409 without row changes', async () => {
    const f = await fixture('default')
    const admin = await user(true)
    for (const [table, id] of [['directory_accounts', f.head.id], ['directory_departments', f.department.id]]) {
      await query(`UPDATE ${table} SET is_active = FALSE WHERE id = $1`, [id])
      const before = await snapshot()
      const get = await request(route(f.head, f.department), admin)
      expect(get.status).toBe(200)
      expect(await get.json()).toEqual(payload(f.head, f.department, false, true))
      await error(await request(route(f.head, f.department), admin, 'PATCH', { isDepartmentHead: true }), 409, 'DIRECTORY_LOCAL_CONFLICT')
      expect(await snapshot()).toEqual(before)
      await query(`UPDATE ${table} SET is_active = TRUE WHERE id = $1`, [id])
    }
  })

  it('archive-first barrier enforces account-before-department locks and rechecks archive state', async () => {
    const f = await fixture('default')
    const admin = await user(true)
    await token(admin) // session writes must finish before introducing the lock barrier
    for (const target of ['account', 'department']) {
      const holder = new Client({ connectionString: process.env.DATABASE_URL })
      const probe = new Client({ connectionString: process.env.DATABASE_URL })
      await holder.connect()
      await probe.connect()
      let pending: Promise<{ response?: Response; failure?: unknown }> | undefined
      try {
        await holder.query('BEGIN')
        const held = target === 'account' ? 'directory_accounts' : 'directory_departments'
        const heldId = target === 'account' ? f.head.id : f.department.id
        await holder.query(`UPDATE ${held} SET is_active = FALSE WHERE id = $1`, [heldId])
        const pid = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid
        pending = request(route(f.head, f.department), admin, 'PATCH', { isDepartmentHead: true })
          .then((response) => ({ response }), (failure: unknown) => ({ failure }))
        let blocked = false
        const deadline = Date.now() + 3000
        while (Date.now() < deadline) {
          const waiters = await query(
            "SELECT pid FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid)) AND wait_event_type = 'Lock' AND query ILIKE '%directory_%'", [pid],
          )
          if (waiters.rows.length === 1) { blocked = true; break }
          await new Promise((done) => setTimeout(done, 20))
        }
        expect(blocked).toBe(true)
        await probe.query('BEGIN')
        if (target === 'department') {
          // Writer is parked on the department and already owns the account lock.
          await expect(probe.query('SELECT id FROM directory_accounts WHERE id = $1 FOR UPDATE NOWAIT', [f.head.id]))
            .rejects.toMatchObject({ code: '55P03' })
        } else {
          // While parked on the account the writer has not locked the department.
          expect((await probe.query('SELECT id FROM directory_departments WHERE id = $1 FOR UPDATE NOWAIT', [f.department.id])).rows)
            .toEqual([{ id: f.department.id }])
        }
        await probe.query('ROLLBACK')
        await holder.query('COMMIT')
        const result = await pending
        expect(result.failure).toBeUndefined()
        await error(result.response!, 409, 'DIRECTORY_LOCAL_CONFLICT')
        expect((await query('SELECT is_department_head, is_manager, is_primary FROM directory_account_departments WHERE directory_account_id = $1 AND directory_department_id = $2',
          [f.head.id, f.department.id])).rows).toEqual([{ is_department_head: false, is_manager: false, is_primary: false }])
        await query(`UPDATE ${held} SET is_active = TRUE WHERE id = $1`, [heldId])
      } finally {
        await probe.query('ROLLBACK')
        await holder.query('ROLLBACK')
        await pending
        await probe.end()
        await holder.end()
      }
    }
  })

  it('R74 active-member HTTP projection→manager→head completes approval and preserves the frozen old head', async () => {
    const admin = await user(true)
    const local = '/api/admin/directory/local'
    // R74 operator path: existing active members use the named projection exception.
    // Only fixture identities/permissions and explicit source selection use SQL.
    const createdDepartment = await request(`${local}/departments`, admin, 'POST', {
      name: `R74 synthetic department ${randomUUID()}`,
    })
    expect(createdDepartment.status).toBe(200)
    const d = (await createdDepartment.json() as { data: { department: Department } }).data.department
    departments.push(d.id)
    const workspace = await request(`${local}/workspace`, admin)
    expect(workspace.status).toBe(200)
    const integration = (await workspace.json() as { data: { integration: { id: string } } }).data.integration.id
    async function projectMember() {
      const localUserId = await user()
      await query("INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, 'default', TRUE)", [localUserId])
      const response = await request(`${local}/member-projections`, admin, 'POST', { integrationId: integration, localUserId })
      expect(response.status).toBe(200)
      const projection = (await response.json() as { data: { projection: { accountId: string; created: boolean } } }).data.projection
      expect(projection.created).toBe(true)
      accounts.push(projection.accountId)
      const membership = await request(`${local}/memberships`, admin, 'POST', { accountId: projection.accountId, departmentId: d.id })
      expect(membership.status).toBe(200)
      return { id: projection.accountId, localUserId }
    }
    const f = { requester: await projectMember(), manager: await projectMember(),
      head: await projectMember(), next: await projectMember(), department: d }
    expect((await request(`${local}/memberships/${f.requester.id}:${d.id}`, admin, 'PATCH', { isPrimary: true })).status).toBe(200)
    expect((await request(`${local}/memberships/${f.manager.id}:${d.id}`, admin, 'PATCH', { isManager: true })).status).toBe(200)
    await policy('default', integration)
    const catalogue = await query("SELECT code FROM permissions WHERE code = ANY($1::text[]) ORDER BY code",
      [['approvals:act', 'approvals:read', 'approvals:write']])
    expect(catalogue.rows).toEqual([{ code: 'approvals:act' }, { code: 'approvals:read' }, { code: 'approvals:write' }])
    for (const [id, codes] of [
      [f.requester.localUserId!, ['approvals:read', 'approvals:write']],
      [f.manager.localUserId!, ['approvals:read', 'approvals:act']],
      [f.head.localUserId!, ['approvals:read', 'approvals:act']],
      [f.next.localUserId!, ['approvals:read', 'approvals:act']],
    ] as const) {
      for (const code of codes) await query('INSERT INTO user_permissions (user_id, permission_code) VALUES ($1, $2)', [id, code])
      invalidateUserPerms(id)
    }
    const graph = {
      nodes: [
        { key: 'start', type: 'start', config: {} },
        ...['manager', 'head'].map((key) => ({
          key, type: 'approval', config: {
            assigneeSources: [{ kind: key === 'manager' ? 'direct_manager' : 'dept_head' }],
            approvalMode: 'single', emptyAssigneePolicy: 'error',
          },
        })),
        { key: 'end', type: 'end', config: {} },
      ],
      edges: [
        { key: 's-m', source: 'start', target: 'manager' },
        { key: 'm-h', source: 'manager', target: 'head' },
        { key: 'h-e', source: 'head', target: 'end' },
      ],
    }
    const createdTemplate = await request('/api/approval-templates', admin, 'POST', {
      key: `native-head-${randomUUID()}`, name: 'Synthetic native head',
      formSchema: { fields: [{ id: 'reason', type: 'text', label: 'Reason', required: true }] },
      approvalGraph: graph,
    })
    expect(createdTemplate.status).toBe(201)
    const template = await createdTemplate.json() as { id: string }
    templates.push(template.id)
    expect((await request(`/api/approval-templates/${template.id}/publish`, admin, 'POST', { policy: { allowRevoke: true } })).status).toBe(200)
    async function set(a: { id: string }, enabled: boolean) {
      const response = await request(route(a, f.department), admin, 'PATCH', { isDepartmentHead: enabled })
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ ok: true, data: { membership: {
        id: `${a.id}:${d.id}`, accountId: a.id, departmentId: d.id, isDepartmentHead: enabled,
      } } })
    }
    async function create() {
      const response = await request('/api/approvals', f.requester.localUserId!, 'POST', { templateId: template.id, formData: { reason: 'synthetic' } })
      expect(response.status).toBe(201)
      const body = await response.json() as { id: string }
      instances.push(body.id)
      return body.id
    }
    async function row(id: string) {
      return (await query('SELECT status, current_node_key, requester_snapshot FROM approval_instances WHERE id = $1', [id])).rows[0]
    }
    async function seat(id: string, node: string, assignee: string) {
      expect((await query('SELECT node_key, assignee_id FROM approval_assignments WHERE instance_id = $1 AND is_active = TRUE ORDER BY node_key, assignee_id', [id])).rows)
        .toEqual([{ node_key: node, assignee_id: assignee }])
    }
    async function approve(id: string, actor: string) {
      expect((await request(`/api/approvals/${id}/actions`, actor, 'POST', { action: 'approve' })).status).toBe(200)
    }
    await set(f.head, true)
    const old = await create()
    const frozen = (await row(old)).requester_snapshot
    expect(frozen).toMatchObject({ id: f.requester.localUserId, managerId: f.manager.localUserId, deptHeadId: f.head.localUserId })
    await seat(old, 'manager', f.manager.localUserId!)
    await set(f.head, false)
    await set(f.next, true)
    expect((await row(old)).requester_snapshot).toEqual(frozen)
    const fresh = await create()
    expect((await row(fresh)).requester_snapshot).toMatchObject({ managerId: f.manager.localUserId, deptHeadId: f.next.localUserId })
    await seat(fresh, 'manager', f.manager.localUserId!)
    await approve(old, f.manager.localUserId!)
    await seat(old, 'head', f.head.localUserId!)
    await approve(fresh, f.manager.localUserId!)
    await seat(fresh, 'head', f.next.localUserId!)
    await approve(old, f.head.localUserId!)
    await approve(fresh, f.next.localUserId!)
    for (const id of [old, fresh]) expect(await row(id)).toMatchObject({ status: 'approved', current_node_key: null })
    expect((await row(old)).requester_snapshot).toEqual(frozen)
  })

  it('integration lock: writer wins, blocks disable and then sets the head', async () => {
    const f = await fixture('default')
    const admin = await user(true)
    await token(admin) // Finish session writes before taking any barrier lock.
    expect((await query('SELECT status FROM directory_integrations WHERE id = $1', [f.integration])).rows)
      .toEqual([{ status: 'active' }])
    expect((await query(
      'SELECT is_department_head FROM directory_account_departments WHERE directory_account_id = $1 AND directory_department_id = $2',
      [f.head.id, f.department.id],
    )).rows).toEqual([{ is_department_head: false }])

    const departmentHolder = new Client({ connectionString: process.env.DATABASE_URL })
    const disabler = new Client({ connectionString: process.env.DATABASE_URL })
    let holderConnected = false
    let disablerConnected = false
    let pending: Promise<{ response?: Response; failure?: unknown }> | undefined
    try {
      await departmentHolder.connect()
      holderConnected = true
      await disabler.connect()
      disablerConnected = true
      await departmentHolder.query('BEGIN')
      await departmentHolder.query('SELECT id FROM directory_departments WHERE id = $1 FOR UPDATE', [f.department.id])
      const pid = (await departmentHolder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid

      pending = request(route(f.head, f.department), admin, 'PATCH', { isDepartmentHead: true })
        .then((response) => ({ response }), (failure: unknown) => ({ failure }))
      let blocked = false
      const deadline = Date.now() + 3000
      while (Date.now() < deadline) {
        const waiters = await query(
          "SELECT pid FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid)) AND wait_event_type = 'Lock' AND query ILIKE '%directory_departments%'",
          [pid],
        )
        if (waiters.rows.length === 1) { blocked = true; break }
        await new Promise((done) => setTimeout(done, 20))
      }
      expect(blocked).toBe(true)

      // The parked writer must already own the account lock.
      await disabler.query('BEGIN')
      await expect(disabler.query('SELECT id FROM directory_accounts WHERE id = $1 FOR UPDATE NOWAIT', [f.head.id]))
        .rejects.toMatchObject({ code: '55P03' })
      await disabler.query('ROLLBACK')

      // Under the corrected integration FOR SHARE lock, status UPDATE cannot win.
      await disabler.query('BEGIN')
      await disabler.query("SET LOCAL lock_timeout = '100ms'")
      await expect(disabler.query("UPDATE directory_integrations SET status = 'disabled' WHERE id = $1", [f.integration]))
        .rejects.toMatchObject({ code: '55P03' })
      await disabler.query('ROLLBACK')
      await departmentHolder.query('COMMIT')

      const result = await pending
      expect(result.failure).toBeUndefined()
      expect(result.response!.status).toBe(200)
      expect(await result.response!.json()).toEqual(payload(f.head, f.department, true))
      expect((await query(
        `SELECT ad.is_department_head, i.status
           FROM directory_account_departments ad
           JOIN directory_accounts a ON a.id = ad.directory_account_id
           JOIN directory_integrations i ON i.id = a.integration_id
          WHERE ad.directory_account_id = $1 AND ad.directory_department_id = $2`,
        [f.head.id, f.department.id],
      )).rows).toEqual([{ is_department_head: true, status: 'active' }])
    } finally {
      // Release every owned lock before draining the HTTP promise. If rollback fails,
      // closing that client is the fallback that releases its transaction locks.
      try {
        await Promise.all([
          holderConnected ? departmentHolder.query('ROLLBACK').catch(() => departmentHolder.end()) : Promise.resolve(),
          disablerConnected ? disabler.query('ROLLBACK').catch(() => disabler.end()) : Promise.resolve(),
        ])
        await pending
        await query("UPDATE directory_integrations SET status = 'active' WHERE id = $1 AND status = 'disabled'", [f.integration])
      } finally {
        await Promise.all([departmentHolder.end(), disabler.end()])
      }
    }
  }, 30_000)

  it('integration lock: committed disable wins, rejects the parked head PATCH without changing its bit', async () => {
    const f = await fixture('default')
    const admin = await user(true)
    await token(admin)
    expect((await query('SELECT status FROM directory_integrations WHERE id = $1', [f.integration])).rows)
      .toEqual([{ status: 'active' }])
    expect((await query(
      'SELECT is_department_head FROM directory_account_departments WHERE directory_account_id = $1 AND directory_department_id = $2',
      [f.head.id, f.department.id],
    )).rows).toEqual([{ is_department_head: false }])

    const disabler = new Client({ connectionString: process.env.DATABASE_URL })
    let disablerConnected = false
    let pending: Promise<{ response?: Response; failure?: unknown }> | undefined
    try {
      await disabler.connect()
      disablerConnected = true
      await disabler.query('BEGIN')
      expect((await disabler.query(
        "UPDATE directory_integrations SET status = 'disabled' WHERE id = $1 RETURNING status", [f.integration],
      )).rows).toEqual([{ status: 'disabled' }])
      const pid = (await disabler.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid

      pending = request(route(f.head, f.department), admin, 'PATCH', { isDepartmentHead: true })
        .then((response) => ({ response }), (failure: unknown) => ({ failure }))
      let blocked = false
      const deadline = Date.now() + 3000
      while (Date.now() < deadline) {
        const waiters = await query(
          "SELECT pid FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid)) AND wait_event_type = 'Lock' AND query ILIKE '%directory_integrations%' AND query ILIKE '%FOR SHARE OF i%'",
          [pid],
        )
        if (waiters.rows.length === 1) { blocked = true; break }
        await new Promise((done) => setTimeout(done, 20))
      }
      expect(blocked).toBe(true)
      await disabler.query('COMMIT')

      const result = await pending
      expect(result.failure).toBeUndefined()
      await error(result.response!, 404, 'DIRECTORY_LOCAL_NOT_FOUND')
      expect((await query(
        `SELECT ad.is_department_head, i.status
           FROM directory_account_departments ad
           JOIN directory_accounts a ON a.id = ad.directory_account_id
           JOIN directory_integrations i ON i.id = a.integration_id
          WHERE ad.directory_account_id = $1 AND ad.directory_department_id = $2`,
        [f.head.id, f.department.id],
      )).rows).toEqual([{ is_department_head: false, status: 'disabled' }])
    } finally {
      try {
        if (disablerConnected) await disabler.query('ROLLBACK').catch(() => disabler.end())
        await pending
        // Initial status was asserted active; touch only this owned fixture integration.
        await query("UPDATE directory_integrations SET status = 'active' WHERE id = $1 AND status = 'disabled'", [f.integration])
      } finally {
        await disabler.end()
      }
    }
  }, 30_000)

  it('default fixture guard refuses a disabled-only anchor before provisioning any identities', async () => {
    // Establish the normal active fixture first. On a fresh owned clone this permits
    // the existing bootstrap; a pre-existing disabled-only anchor must already refuse
    // here under the new guard and must not be revived as setup for this case.
    const f = await fixture('default')
    const anchorSql = `SELECT i.status, i.updated_at::text AS updated_at,
                             md5(to_jsonb(i)::text) AS row_fingerprint
                        FROM directory_integrations i
                       WHERE i.id = $1 AND i.org_id = 'default' AND i.provider = 'local'`
    const priorRows = (await query<{
      status: string; updated_at: string; row_fingerprint: string
    }>(anchorSql, [f.integration])).rows
    expect(priorRows).toHaveLength(1)
    const prior = priorRows[0]!
    expect(prior.status).toBe('active')

    const bookkeepingBefore = {
      users: [...users], accounts: [...accounts], departments: [...departments],
      integrations: [...integrations], templates: [...templates], instances: [...instances],
      policyOrgs: [...policies.keys()], tokenUsers: [...tokens.keys()],
    }

    // Fixed identifiers only. Return exact counts plus whole-row fingerprints,
    // rather than materializing user/config/audit values into assertion output.
    // These are the tables touched by fixture provisioning and its access graph.
    async function provisioningState() {
      const state: Record<string, { count: number; fingerprint: string }> = {}
      for (const table of [
        'users', 'directory_integrations', 'directory_accounts', 'directory_departments',
        'directory_account_links', 'directory_account_departments', 'user_orgs',
        'org_directory_routing_policy', 'audit_logs',
      ]) {
        const result = await query<{ count: number; fingerprint: string }>(
          `SELECT count(*)::int AS count,
                  md5(COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text), '[]'::jsonb)::text) AS fingerprint
             FROM ${table} t`,
        )
        state[table] = result.rows[0]!
      }
      return state
    }
    const reactivationSql = `SELECT count(*)::int AS count
                               FROM audit_logs
                              WHERE resource_id = $1
                                AND action = 'directory.local_integration.reactivate'`

    const priorAuditIds = (await query<{ id: string }>(
      "SELECT id::text AS id FROM audit_logs WHERE resource_id = $1 AND action = 'directory.local_integration.reactivate'",
      [f.integration],
    )).rows.map(row => row.id)
    let disabled = false
    try {
      // Intentionally change status alone; preserve the original timestamp until finally.
      expect((await query(
        "UPDATE directory_integrations SET status = 'disabled' WHERE id = $1 AND status = 'active' RETURNING status",
        [f.integration],
      )).rows).toEqual([{ status: 'disabled' }])
      disabled = true
      const defaultStatuses = (await query<{ status: string }>(
        "SELECT status FROM directory_integrations WHERE org_id = 'default' AND provider = 'local'",
      )).rows
      expect(defaultStatuses.length).toBeGreaterThan(0)
      expect(defaultStatuses.some((row) => row.status === 'active')).toBe(false)

      const disabledRows = (await query(anchorSql, [f.integration])).rows
      expect(disabledRows).toHaveLength(1)
      expect(disabledRows[0]).toMatchObject({ status: 'disabled', updated_at: prior.updated_at })
      const before = await provisioningState()
      const reactivationBefore = (await query(reactivationSql, [f.integration])).rows

      await expect(fixture('default')).rejects.toEqual(
        new Error('Native head fixture requires an active default local anchor'),
      )

      // No growth, replacement or other change in any fixture bookkeeping.
      expect({
        users: [...users], accounts: [...accounts], departments: [...departments],
        integrations: [...integrations], templates: [...templates], instances: [...instances],
        policyOrgs: [...policies.keys()], tokenUsers: [...tokens.keys()],
      }).toEqual(bookkeepingBefore)
      // Count equality alone cannot hide updates to existing rows: fingerprints cover them.
      expect(await provisioningState()).toEqual(before)
      expect((await query(reactivationSql, [f.integration])).rows).toEqual(reactivationBefore)
      expect((await query(anchorSql, [f.integration])).rows).toEqual(disabledRows)
    } finally {
      if (disabled) {
        // Only the explicitly owned fixture integration is restored. Preserve the exact
        // original text timestamp, including fractional precision, without JS Date conversion.
        expect((await query(
          `UPDATE directory_integrations
              SET status = $2, updated_at = $3::timestamptz
            WHERE id = $1 AND org_id = 'default' AND provider = 'local'
            RETURNING status, updated_at::text AS updated_at`,
          [f.integration, prior.status, prior.updated_at],
        )).rows).toEqual([{ status: prior.status, updated_at: prior.updated_at }])
        expect((await query(anchorSql, [f.integration])).rows).toEqual(priorRows)
        // If the guard is deliberately removed for the matching mutation, remove only
        // the reactivation audit caused by this owned fixture, retaining every prior row.
        await query(
          "DELETE FROM audit_logs WHERE resource_id = $1 AND action = 'directory.local_integration.reactivate' AND NOT (id::text = ANY($2::text[]))",
          [f.integration, priorAuditIds],
        )
      }
    }
  }, 30_000)
})
