import { randomUUID } from 'node:crypto'
import express from 'express'
import { Client } from 'pg'
import request from 'supertest'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const url = process.env.PERMISSION_COMMAND_FENCE_DATABASE_URL
if (url) {
  const endpoint = new URL(url)
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)
      || !['/permission_command_fence_test', '/delegation_activation'].includes(endpoint.pathname)) {
    throw new Error('isolated migrated loopback fixture required')
  }
}

const suite = url ? describe : describe.skip
suite('delegated scope activation on the real PostgreSQL management routes', () => {
  const platform = randomUUID()
  const delegate = randomUUID()
  const member = randomUUID()
  const namespace = `toggle-${randomUUID()}`
  const role = `${namespace}_admin`
  const memberRole = `${namespace}_reader`
  const delegateScopes = `/api/admin/role-delegation/users/${delegate}`
  const capabilities = '/api/admin/access-capabilities'
  let db: Client
  let group: string
  let app: express.Express
  let platformToken: string
  let delegateToken: string
  let closePool: () => Promise<void>

  const states = (path = `${delegateScopes}/scopes`) => request(app).get(path).auth(platformToken, { type: 'bearer' })
  const state = async () => {
    const result = await states()
    expect(result.status, JSON.stringify(result.body)).toBe(200)
    expect(result.body.data.scopeActivations).toHaveLength(1)
    return result.body.data.scopeActivations[0]
  }
  const toggle = (enabled: boolean, expectedVersion: string, token = platformToken) =>
    request(app).post(`${delegateScopes}/scopes/activation`).auth(token, { type: 'bearer' })
      .send({ namespace, enabled, expectedVersion })
  const scopeGroup = (action: 'assign' | 'unassign') =>
    request(app).post(`${delegateScopes}/scope-groups/${action}`).auth(platformToken, { type: 'bearer' })
      .send({ namespace, groupId: group })
  const changeRole = (action: 'assign' | 'unassign', userId: string, roleId: string, token = platformToken) =>
    request(app).post(`/api/admin/role-delegation/users/${userId}/roles/${action}`).auth(token, { type: 'bearer' })
      .send({ roleId })
  const auditCount = async () => Number((await db.query(
    "SELECT count(*) FROM audit_logs WHERE resource_type='delegated-admin-activation' AND resource_id=$1",
    [`${delegate}:${namespace}`],
  )).rows[0]?.count)
  const permissionRows = async () => (await db.query(
    `SELECT (SELECT enabled FROM user_namespace_admissions WHERE user_id=$1 AND namespace=$2) AS admission,
            (SELECT EXISTS(SELECT 1 FROM user_roles WHERE user_id=$1 AND role_id=$3)) AS role,
            (SELECT count(*)::int FROM delegated_role_admin_member_groups WHERE admin_user_id=$1 AND namespace=$2) AS groups`,
    [delegate, namespace, role],
  )).rows[0]

  beforeAll(async () => {
    db = new Client({ connectionString: url })
    await db.connect()
    for (const id of [platform, delegate, member]) {
      await db.query(`INSERT INTO users(id,email,name,password_hash,role,is_active,activation_status)
        VALUES ($1,$2,'synthetic','synthetic',$3,true,'activated')`, [id, `${id}@example.test`, id === platform ? 'admin' : 'user'])
    }
    await db.query("INSERT INTO user_roles(user_id,role_id) VALUES ($1,'admin')", [platform])
    await db.query('INSERT INTO roles(id,name) VALUES ($1,$1),($2,$2)', [role, memberRole])
    await db.query('INSERT INTO permissions(code,name) VALUES ($1,$1)', [`${namespace}:read`])
    await db.query('INSERT INTO role_permissions(role_id,permission_code) VALUES ($1,$3),($2,$3)', [role, memberRole, `${namespace}:read`])
    const created = await db.query('INSERT INTO platform_member_groups(name) VALUES ($1) RETURNING id', [namespace])
    group = created.rows[0].id
    await db.query('INSERT INTO platform_member_group_members(group_id,user_id) VALUES ($1,$2)', [group, member])
    vi.stubEnv('DATABASE_URL', url)
    vi.stubEnv('JWT_SECRET', 'synthetic-delegated-scope-activation-test-only')
    vi.stubEnv('PRODUCT_MODE', 'attendance')
    vi.stubEnv('RBAC_BYPASS', 'false')
    vi.stubEnv('RBAC_TOKEN_TRUST', 'false')
    const [{ adminUsersRouter }, { authService }, { poolManager }] = await Promise.all([
      import('../../src/routes/admin-users'), import('../../src/auth/AuthService'), import('../../src/integration/db/connection-pool'),
    ])
    const tokenFor = (id: string) => authService.createToken({
      id, email: `${id}@example.test`, name: 'synthetic', role: 'user', permissions: [], created_at: new Date(), updated_at: new Date(),
    })
    platformToken = tokenFor(platform)
    delegateToken = tokenFor(delegate)
    app = express()
    app.use(express.json())
    app.use(adminUsersRouter())
    closePool = () => poolManager.close()
  }, 60_000)

  beforeEach(async () => {
    process.env.DELEGATED_SCOPE_ACTIVATION_ENABLED = 'true'
    await db.query('DELETE FROM delegated_role_admin_activation WHERE admin_user_id=$1', [delegate])
    await db.query('DELETE FROM delegated_role_admin_member_groups WHERE admin_user_id=$1', [delegate])
    await db.query('DELETE FROM user_namespace_admissions WHERE user_id=$1 AND namespace=$2', [delegate, namespace])
    await db.query('DELETE FROM user_roles WHERE user_id=ANY($1::text[])', [[delegate, member]])
    await db.query('INSERT INTO user_roles(user_id,role_id) VALUES ($1,$2)', [delegate, role])
    await db.query(`INSERT INTO user_namespace_admissions(user_id,namespace,enabled,source)
      VALUES ($1,$2,true,'manual')`, [delegate, namespace])
    await db.query("DELETE FROM audit_logs WHERE resource_id=$1 AND resource_type='delegated-admin-activation'", [`${delegate}:${namespace}`])
  })

  afterEach(() => { delete process.env.DELEGATED_SCOPE_ACTIVATION_ENABLED })
  afterAll(async () => {
    vi.unstubAllEnvs()
    if (closePool) await closePool()
    if (!db) return
    await db.query("DELETE FROM audit_logs WHERE resource_id=$1 AND resource_type='delegated-admin-activation'", [`${delegate}:${namespace}`])
    await db.query('DELETE FROM delegated_role_admin_member_groups WHERE admin_user_id=$1', [delegate])
    await db.query('DELETE FROM user_namespace_admissions WHERE user_id=$1 AND namespace=$2', [delegate, namespace])
    await db.query('DELETE FROM user_roles WHERE user_id=ANY($1::text[])', [[platform, delegate, member]])
    await db.query('DELETE FROM platform_member_groups WHERE id=$1', [group])
    await db.query('DELETE FROM role_permissions WHERE role_id=ANY($1::text[])', [[role, memberRole]])
    await db.query('DELETE FROM roles WHERE id=ANY($1::text[])', [[role, memberRole]])
    await db.query('DELETE FROM permissions WHERE code=$1', [`${namespace}:read`])
    await db.query('DELETE FROM users WHERE id=ANY($1::text[])', [[platform, delegate, member]])
    await db.end()
  })

  it('saves a group while stopped and requires explicit activation before delegation', async () => {
    const empty = await state()
    expect(empty).toMatchObject({ namespace, enabled: false, hasConfiguredScope: false })
    const declined = await toggle(true, empty.version)
    expect(declined.status).toBe(409)
    expect(declined.body.error.code).toBe('ROLE_DELEGATION_ACTIVATION_SCOPE_REQUIRED')
    expect(await auditCount()).toBe(0)
    const saved = await scopeGroup('assign')
    expect(saved.status, JSON.stringify(saved.body)).toBe(200)
    const draft = await state()
    expect(draft).toMatchObject({ enabled: false, hasConfiguredScope: true })
    expect((await changeRole('assign', member, memberRole, delegateToken)).status).toBe(403)
    const enabled = await toggle(true, draft.version)
    expect(enabled.status, JSON.stringify(enabled.body)).toBe(200)
    expect(enabled.body.data).toEqual({ actorId: platform, userId: delegate, namespace, enabled: true })
    expect(await auditCount()).toBe(1)
    expect((await changeRole('assign', member, memberRole, delegateToken)).status).toBe(200)
    const removeLast = await scopeGroup('unassign')
    expect(removeLast.status).toBe(409)
    expect(await permissionRows()).toEqual({ admission: true, role: true, groups: 1 })
  })

  it('honors a stored stop with the rollout disabled and preserves role admission and scope', async () => {
    await db.query('INSERT INTO delegated_role_admin_member_groups(admin_user_id,namespace,group_id,created_by) VALUES ($1,$2,$3,$4)', [delegate, namespace, group, platform])
    const old = await state()
    expect(old).toMatchObject({ enabled: true, hasConfiguredScope: true })
    expect((await toggle(false, old.version, delegateToken)).status).toBe(403)
    const stopped = await toggle(false, old.version)
    expect(stopped.status, JSON.stringify(stopped.body)).toBe(200)
    expect(await permissionRows()).toEqual({ admission: true, role: true, groups: 1 })
    process.env.DELEGATED_SCOPE_ACTIVATION_ENABLED = 'false'
    expect((await states()).body.data.scopeActivations).toBeUndefined()
    expect((await toggle(true, old.version)).status).toBe(403)
    expect((await request(app).get(capabilities).auth(delegateToken, { type: 'bearer' })).body.data.canManageScope).toBe(false)
    expect((await changeRole('assign', member, memberRole, delegateToken)).status).toBe(403)
    expect(await auditCount()).toBe(1)
  })

  it('clears the dormant audience on revocation and keeps a fresh appointment stopped', async () => {
    expect((await scopeGroup('assign')).status).toBe(200)
    const oldDraft = await state()
    expect((await changeRole('unassign', delegate, role)).status).toBe(200)
    expect((await states()).body.data.scopeActivations).toEqual([])
    expect((await changeRole('assign', delegate, role)).status).toBe(200)
    const newDraft = await state()
    expect(newDraft).toMatchObject({ enabled: false, hasConfiguredScope: false })
    expect((await toggle(true, oldDraft.version)).status).toBe(409)
    expect(await auditCount()).toBe(0)
    expect((await scopeGroup('assign')).status).toBe(200)
    expect((await state()).enabled).toBe(false)
  })

  it('does not apply an old version after a pause and resume', async () => {
    await db.query('INSERT INTO delegated_role_admin_member_groups(admin_user_id,namespace,group_id,created_by) VALUES ($1,$2,$3,$4)', [delegate, namespace, group, platform])
    const baseline = await state()
    expect((await toggle(false, baseline.version)).status).toBe(200)
    expect((await toggle(true, (await state()).version)).status).toBe(200)
    const stale = await toggle(false, baseline.version)
    expect(stale.status).toBe(409)
    expect(stale.body.error.code).toBe('ROLE_DELEGATION_ACTIVATION_CONFLICT')
    expect((await state()).enabled).toBe(true)
    expect(await auditCount()).toBe(2)
  })

  it('rolls back the activation when mandatory audit insertion fails', async () => {
    expect((await scopeGroup('assign')).status).toBe(200)
    const before = await state()
    await db.query(`CREATE FUNCTION delegation_activation_audit_probe() RETURNS trigger
      LANGUAGE plpgsql AS $probe$ BEGIN
        IF NEW.resource_type = 'delegated-admin-activation' THEN
          RAISE EXCEPTION 'synthetic activation audit failure';
        END IF;
        RETURN NEW;
      END $probe$`)
    await db.query(`CREATE TRIGGER delegation_activation_audit_fail BEFORE INSERT ON audit_logs
      FOR EACH ROW EXECUTE FUNCTION delegation_activation_audit_probe()`)
    try {
      const failed = await toggle(true, before.version)
      expect(failed.status).toBe(500)
      expect(failed.body.error.code).toBe('ROLE_DELEGATION_ACTIVATION_FAILED')
      expect(await state()).toEqual(before)
      expect(await auditCount()).toBe(0)
      await db.query(`CREATE OR REPLACE FUNCTION delegation_activation_audit_probe() RETURNS trigger
        LANGUAGE plpgsql AS $probe$ BEGIN
          IF NEW.resource_type = 'delegated-admin-activation' THEN RETURN NULL; END IF;
          RETURN NEW;
        END $probe$`)
      expect((await toggle(true, before.version)).status).toBe(500)
      expect(await state()).toEqual(before)
      expect(await auditCount()).toBe(0)
    } finally {
      await db.query('DROP TRIGGER delegation_activation_audit_fail ON audit_logs')
      await db.query('DROP FUNCTION delegation_activation_audit_probe()')
    }
    expect((await toggle(true, before.version)).status).toBe(200)
    expect(await auditCount()).toBe(1)
  })

  it('rechecks the stopped actor inside a queued legacy role write', async () => {
    await db.query('INSERT INTO delegated_role_admin_member_groups(admin_user_id,namespace,group_id,created_by) VALUES ($1,$2,$3,$4)', [delegate, namespace, group, platform])
    const holder = new Client({ connectionString: url })
    await holder.connect()
    await holder.query('BEGIN')
    const pid = (await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
    let pending: Promise<request.Response> | undefined
    try {
      await holder.query('SELECT id FROM roles WHERE id=$1 FOR UPDATE', [memberRole])
      pending = changeRole('assign', member, memberRole, delegateToken).then((response) => response)
      const deadline = Date.now() + 5000
      let blocked = false
      while (!blocked && Date.now() < deadline) {
        const waiting = await db.query(`SELECT EXISTS (
          SELECT 1 FROM pg_stat_activity
          WHERE wait_event_type='Lock' AND $1=ANY(pg_blocking_pids(pid))
            AND query LIKE '%FROM roles%' AND query LIKE '%FOR SHARE%'
        ) AS blocked`, [pid])
        blocked = waiting.rows[0].blocked === true
        if (!blocked) await new Promise((resolve) => setTimeout(resolve, 20))
      }
      expect(blocked).toBe(true)
      await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`namespace-admission:${delegate}`])
      await holder.query(`INSERT INTO delegated_role_admin_activation(admin_user_id,namespace,enabled,revision)
        VALUES ($1,$2,false,$3)`, [delegate, namespace, randomUUID()])
      await holder.query('COMMIT')
      expect((await pending).status).toBe(403)
      expect((await db.query('SELECT 1 FROM user_roles WHERE user_id=$1 AND role_id=$2', [member, memberRole])).rowCount).toBe(0)
    } finally {
      await holder.query('ROLLBACK')
      await holder.end()
      await pending
    }
  })
})
