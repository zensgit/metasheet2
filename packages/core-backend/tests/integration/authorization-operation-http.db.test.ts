import { randomUUID } from 'node:crypto'
import { Client } from 'pg'
import express from 'express'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

const url = process.env.PERMISSION_COMMAND_TEST_DATABASE_URL
if (url) {
  const parsed = new URL(url)
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) || parsed.pathname !== '/permission_command_test') {
    throw new Error('authorization-operation tests require the isolated loopback fixture database')
  }
}
const suite = url ? describe : describe.skip
const unfencedFixture = process.env.PERMISSION_COMMAND_TEST_UNFENCED_FIXTURE === '1'
const schema = `permission_command_${randomUUID().replaceAll('-', '')}`
const control = new Client({ connectionString: url })
const actor = randomUUID(), target = randomUUID(), other = randomUUID()
let app: express.Express
let token: (id: string) => string
let poolClose: () => Promise<void>
const base = { targetUserId: target, action: { kind: 'role.assign', roleId: 'attendance_member' }, admissionChanges: [{ namespace: 'attendance', enabled: true }] }
const path = '/api/admin/authorization-operations'

suite('isolated authorization-operation fixture', () => {
beforeAll(async () => {
  await control.connect()
  await control.query(`CREATE SCHEMA "${schema}"`)
  await control.query(`SET search_path TO "${schema}"`)
  await control.query(`
    CREATE TABLE users (id text PRIMARY KEY, name text, email text, username text, mobile text, role text,
      is_admin boolean DEFAULT false, is_active boolean DEFAULT true, activation_status text DEFAULT 'activated',
      access_generation bigint DEFAULT 0, deleted_at timestamptz, purged_at timestamptz, permissions jsonb DEFAULT '[]',
      password_hash text, must_change_password boolean DEFAULT false, local_password_set boolean DEFAULT true,
      created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
    CREATE TABLE roles (id text PRIMARY KEY, name text, updated_at timestamptz DEFAULT now());
    CREATE TABLE permissions (code text PRIMARY KEY, name text);
    CREATE TABLE user_roles (user_id text, role_id text, assignment_source text, PRIMARY KEY(user_id, role_id));
    CREATE TABLE role_permissions (role_id text, permission_code text, PRIMARY KEY(role_id, permission_code));
    CREATE TABLE user_permissions (user_id text, permission_code text, PRIMARY KEY(user_id, permission_code));
    CREATE TABLE user_namespace_admissions (user_id text, namespace text, enabled boolean, source text, granted_by text, updated_by text, created_at timestamptz, updated_at timestamptz, PRIMARY KEY(user_id, namespace));
    CREATE TABLE delegated_role_admin_scopes (id text PRIMARY KEY, admin_user_id text, namespace text, directory_department_id text, include_children boolean);
    CREATE TABLE delegated_role_admin_member_groups (id text PRIMARY KEY, admin_user_id text, namespace text, group_id text);
    CREATE TABLE delegated_role_admin_activation (admin_user_id text, namespace text, enabled boolean NOT NULL, revision uuid NOT NULL, PRIMARY KEY(admin_user_id, namespace));
    CREATE TABLE user_session_revocations (user_id text PRIMARY KEY, revoked_after timestamptz, updated_at timestamptz, updated_by text, reason text);
    CREATE TABLE user_sessions (id text, user_id text, revoked_at timestamptz);
    CREATE TABLE authorization_operation_receipts (actor_id text NOT NULL, client_operation_id uuid NOT NULL, request_digest text NOT NULL, expected_version text NOT NULL, target_user_id text NOT NULL, action jsonb NOT NULL, receipt jsonb NOT NULL, created_at timestamptz DEFAULT now(), PRIMARY KEY(actor_id, client_operation_id));
    CREATE TABLE authorization_operation_audit (actor_id text NOT NULL, client_operation_id uuid NOT NULL, reason text, reason_origin text NOT NULL, impact jsonb NOT NULL, created_at timestamptz DEFAULT now(), PRIMARY KEY(actor_id, client_operation_id), FOREIGN KEY(actor_id, client_operation_id) REFERENCES authorization_operation_receipts(actor_id, client_operation_id));
    INSERT INTO roles(id, name) VALUES ('admin','admin'), ('attendance_member','member');
    INSERT INTO role_permissions VALUES ('attendance_member','attendance:read');
  `)
  const testUrl = new URL(url)
  testUrl.searchParams.set('options', `-c search_path=${schema}`)
  process.env.DATABASE_URL = testUrl.toString()
  process.env.JWT_SECRET = 'synthetic-test-secret-for-permission-command-only'
  process.env.PRODUCT_MODE = 'plm-workbench'
  process.env.RBAC_TOKEN_TRUST = 'false'
  process.env.RBAC_BYPASS = 'false'
  const [{ adminUsersRouter }, { authService }, { poolManager }] = await Promise.all([
    import('../../src/routes/admin-users'), import('../../src/auth/AuthService'), import('../../src/integration/db/connection-pool'),
  ])
  app = express(); app.use(express.json()); app.use(adminUsersRouter())
  token = (id) => authService.createToken({ id, email: `${id}@example.test`, name: 'synthetic', role: 'user', permissions: [], created_at: new Date(), updated_at: new Date() })
  poolClose = () => poolManager.close()
}, 60000)

afterAll(async () => {
  if (poolClose) await poolClose()
  await control.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
  await control.end()
})
beforeEach(async () => {
  await control.query('TRUNCATE authorization_operation_audit, authorization_operation_receipts, user_namespace_admissions, user_permissions, user_roles, delegated_role_admin_scopes, delegated_role_admin_member_groups, delegated_role_admin_activation, user_session_revocations, users')
  await control.query(`INSERT INTO users (id,name,email,role,is_admin) VALUES ($1,'operator','operator@example.test','admin',true), ($2,'target','target@example.test','user',false), ($3,'other','other@example.test','admin',true)`, [actor,target,other])
  await control.query("INSERT INTO user_roles VALUES ($1,'admin'),($2,'admin')", [actor,other])
})
async function preview(body = base, who = actor) {
  return request(app).post(`${path}/preview`).auth(token(who), { type: 'bearer' }).send(body)
}
async function commit(version: string, id: string, body = base, who = actor) {
  return request(app).post(path).auth(token(who), { type: 'bearer' }).send({ ...body, expectedVersion: version, clientOperationId: id })
}

async function waitForLockWaiter() {
  const deadline = Date.now() + 4000
  while (Date.now() < deadline) {
    const result = await control.query("SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND NOT granted) AS waiting")
    if (result.rows[0].waiting === true) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('synthetic lock waiter did not appear')
}
async function waitForAnyLockWaiter() {
  const deadline = Date.now() + 4000
  while (Date.now() < deadline) {
    const result = await control.query("SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock') AS waiting")
    if (result.rows[0].waiting === true) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('synthetic row-lock waiter did not appear')
}
describe('authorization operation real HTTP and synthetic PostgreSQL', () => {
  ;(unfencedFixture ? it.skip : it)('rejects an unattested schema without any authorization writes', async () => {
    const result = await preview(); expect(result.status).toBe(503); expect(result.body.error.code).toBe('AUTHORIZATION_OPERATION_FENCE_UNAVAILABLE')
    const write = await commit(`opaque-v1:${'a'.repeat(64)}`, randomUUID()); expect(write.status).toBe(503); expect(write.body.error.code).toBe('AUTHORIZATION_OPERATION_FENCE_UNAVAILABLE')
    expect((await control.query('SELECT count(*)::int AS n FROM authorization_operation_receipts')).rows[0].n).toBe(0)
  })

  describe.skipIf(!unfencedFixture)('in-memory opened gate: fixture only, not a fence guarantee', () => {
  it('previews and atomically commits, then replays before stale check and rejects changed key', async () => {
    const pre = await preview(); expect(pre.status, JSON.stringify(pre.body)).toBe(200)
    expect(pre.body.impact.effectiveAfter).toEqual([{ code: 'attendance:read', sources: [{ kind: 'role', id: 'attendance_member' }], effective: true }])
    const id = randomUUID(), done = await commit(pre.body.expectedVersion, id)
    expect(done.status, JSON.stringify(done.body)).toBe(200)
    expect(done.body.status).toBe('committed')
    expect((await control.query('SELECT actor_id FROM authorization_operation_audit')).rows).toEqual([{ actor_id: actor }])
    expect((await control.query("SELECT count(*)::int AS n FROM user_roles WHERE user_id=$1 AND role_id='attendance_member'", [target])).rows[0].n).toBe(1)
    const replay = await commit(pre.body.expectedVersion, id); expect(replay.status).toBe(200); expect(replay.body).toEqual(done.body)
    const changed = await commit(pre.body.expectedVersion, id, { ...base, reason: 'different' }); expect(changed.status).toBe(409); expect(changed.body.error.code).toBe('IDEMPOTENCY_CONFLICT')
    const lookup = await request(app).get(`${path}/${id}`).auth(token(actor), { type: 'bearer' }); expect(lookup.body).toEqual(done.body)
  })
  it('audit failure rolls back the role, admission and receipt', async () => {
    const pre = await preview(); expect(pre.status).toBe(200)
    await control.query(`CREATE FUNCTION fail_operation_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic audit failure'; END $$; CREATE TRIGGER fail_audit BEFORE INSERT ON authorization_operation_audit FOR EACH ROW EXECUTE FUNCTION fail_operation_audit()`)
    try {
      const done = await commit(pre.body.expectedVersion, randomUUID()); expect(done.status).toBe(503)
      expect((await control.query("SELECT count(*)::int AS n FROM user_roles WHERE user_id=$1 AND role_id='attendance_member'", [target])).rows[0].n).toBe(0)
      expect((await control.query('SELECT count(*)::int AS n FROM authorization_operation_receipts')).rows[0].n).toBe(0)
      expect((await control.query('SELECT count(*)::int AS n FROM user_namespace_admissions')).rows[0].n).toBe(0)
    } finally { await control.query('DROP TRIGGER fail_audit ON authorization_operation_audit; DROP FUNCTION fail_operation_audit()') }
  })
  it('reports unknown while a pending same-key operation waits, then exposes committed receipt', async () => {
    const pre = await preview(); expect(pre.status).toBe(200)
    const id = randomUUID(), holder = new Client({ connectionString: url, options: `-c search_path=${schema}` })
    await holder.connect(); await holder.query('BEGIN')
    await holder.query("SELECT pg_advisory_xact_lock(hashtextextended('authorization-operation:' || $1, 0))", [JSON.stringify([actor,id])])
    const pending = commit(pre.body.expectedVersion, id).then(value => value)
    try {
      await waitForLockWaiter()
      const observed = await request(app).get(`${path}/${id}`).auth(token(actor), { type: 'bearer' })
      expect(observed.status).toBe(200); expect(observed.body.status).toBe('unknown_or_pending')
    } finally { await holder.query('COMMIT'); await holder.end() }
    const done = await pending; expect(done.status, JSON.stringify(done.body)).toBe(200)
    const after = await request(app).get(`${path}/${id}`).auth(token(actor), { type: 'bearer' }); expect(after.body.status).toBe('committed')
  })
  it('denies an actor whose authority is revoked while the command waits', async () => {
    const pre = await preview(); expect(pre.status).toBe(200)
    const holder = new Client({ connectionString: url, options: `-c search_path=${schema}` })
    await holder.connect(); await holder.query('BEGIN')
    await holder.query("SELECT pg_advisory_xact_lock(hashtextextended('user-recycle:platform-admin', 0))")
    const pending = commit(pre.body.expectedVersion, randomUUID()).then(value => value)
    try {
      await waitForLockWaiter()
      await holder.query("DELETE FROM user_roles WHERE user_id=$1 AND role_id='admin'", [actor])
      await holder.query("UPDATE users SET role='user', is_admin=false WHERE id=$1", [actor])
    } finally { await holder.query('COMMIT'); await holder.end() }
    const result = await pending
    expect(result.status).toBe(403)
    expect((await control.query("SELECT count(*)::int AS n FROM user_roles WHERE user_id=$1 AND role_id='attendance_member'", [target])).rows[0].n).toBe(0)
  })
  it('rejects a changed role witness and does not write a receipt', async () => {
    const pre = await preview(); expect(pre.status).toBe(200)
    await control.query("INSERT INTO role_permissions VALUES ('attendance_member','attendance:write')")
    try {
      const result = await commit(pre.body.expectedVersion, randomUUID())
      expect(result.status).toBe(409); expect(result.body.error.code).toBe('STALE_PREVIEW')
      expect((await control.query('SELECT count(*)::int AS n FROM authorization_operation_receipts')).rows[0].n).toBe(0)
    } finally { await control.query("DELETE FROM role_permissions WHERE permission_code='attendance:write'") }
  })
  it('denies receipt reads after the actor loses platform authority', async () => {
    const pre = await preview(); const id = randomUUID()
    expect((await commit(pre.body.expectedVersion, id)).status).toBe(200)
    await control.query("DELETE FROM user_roles WHERE user_id=$1 AND role_id='admin'", [actor])
    await control.query("UPDATE users SET role='user', is_admin=false WHERE id=$1", [actor])
    const response = await request(app).get(`${path}/${id}`).auth(token(actor), { type: 'bearer' })
    expect(response.status).toBe(403); expect(response.body.error.code).toBe('FORBIDDEN')
  })
  it('preserves a sign-in admin when two admins concurrently revoke each other', async () => {
    const left = { targetUserId: other, action: { kind: 'role.revoke', roleId: 'admin' }, admissionChanges: [] }
    const right = { targetUserId: actor, action: { kind: 'role.revoke', roleId: 'admin' }, admissionChanges: [] }
    const [p1,p2] = await Promise.all([preview(left, actor),preview(right, other)])
    expect(p1.status).toBe(200); expect(p2.status).toBe(200)
    const [a,b] = await Promise.all([commit(p1.body.expectedVersion, randomUUID(), left, actor),commit(p2.body.expectedVersion, randomUUID(), right, other)])
    expect([a.status,b.status].filter(status => status === 200)).toHaveLength(1)
    const remaining = await control.query("SELECT count(*)::int AS n FROM users u WHERE role='admin' AND is_active AND activation_status='activated' AND EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id=u.id AND ur.role_id='admin')")
    expect(remaining.rows[0].n).toBeGreaterThanOrEqual(1)
  })
  it('rolls back a role assignment when the following admission write fails', async () => {
    const pre = await preview(); expect(pre.status).toBe(200)
    await control.query(`CREATE FUNCTION fail_operation_admission() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic admission failure'; END $$; CREATE TRIGGER fail_admission BEFORE INSERT ON user_namespace_admissions FOR EACH ROW EXECUTE FUNCTION fail_operation_admission()`)
    try {
      const done = await commit(pre.body.expectedVersion, randomUUID()); expect(done.status).toBe(503)
      expect((await control.query("SELECT count(*)::int AS n FROM user_roles WHERE user_id=$1 AND role_id='attendance_member'", [target])).rows[0].n).toBe(0)
      expect((await control.query('SELECT count(*)::int AS n FROM authorization_operation_receipts')).rows[0].n).toBe(0)
    } finally { await control.query('DROP TRIGGER fail_admission ON user_namespace_admissions; DROP FUNCTION fail_operation_admission()') }
  })

  it('preserves retained direct and legacy grants but masks them after role revoke', async () => {
    await control.query("INSERT INTO user_roles VALUES ($1,'attendance_member')", [target])
    await control.query("INSERT INTO user_permissions VALUES ($1,'attendance:read')", [target])
    await control.query("UPDATE users SET permissions='[\"attendance:read\"]'::jsonb WHERE id=$1", [target])
    await control.query("INSERT INTO user_namespace_admissions (user_id, namespace, enabled, source) VALUES ($1,'attendance',true,'platform_admin')", [target])
    const body = { targetUserId: target, action: { kind: 'role.revoke', roleId: 'attendance_member' }, admissionChanges: [] }
    const pre = await preview(body); expect(pre.status, JSON.stringify(pre.body)).toBe(200)
    expect(pre.body.impact.admissionChanges).toEqual([{ namespace: 'attendance', before: true, after: false, cause: 'role_revoke' }])
    expect(pre.body.impact.retainedOtherGrants[0]).toMatchObject({ code: 'attendance:read', effective: false })
    expect(pre.body.impact.retainedOtherGrants[0].sources.map((source: {kind:string}) => source.kind).sort()).toEqual(['direct','legacy'])
    const done = await commit(pre.body.expectedVersion, randomUUID(), body); expect(done.status, JSON.stringify(done.body)).toBe(200)
    expect(done.body.receipt.impact).toEqual(pre.body.impact)
    expect((await control.query("SELECT enabled,source FROM user_namespace_admissions WHERE user_id=$1 AND namespace='attendance'", [target])).rows[0]).toEqual({ enabled: false, source: 'role_unassigned' })
  })
  it('records attendance employee opt-out without disabling remaining role admission', async () => {
    await control.query("INSERT INTO roles(id,name) VALUES ('attendance_employee','employee')")
    await control.query("INSERT INTO role_permissions VALUES ('attendance_employee','attendance:read')")
    await control.query("INSERT INTO user_roles VALUES ($1,'attendance_member'),($1,'attendance_employee')", [target])
    await control.query("INSERT INTO user_namespace_admissions (user_id, namespace, enabled, source) VALUES ($1,'attendance',true,'platform_admin')", [target])
    const body = { targetUserId: target, action: { kind: 'role.revoke', roleId: 'attendance_employee' }, admissionChanges: [] }
    try {
      const pre = await preview(body); expect(pre.status, JSON.stringify(pre.body)).toBe(200)
      expect(pre.body.impact.warnings).toContain('attendance_employee_opt_out')
      expect(pre.body.impact.admissionChanges).toEqual([{ namespace: 'attendance', before: true, after: true, cause: 'role_revoke' }])
      const done = await commit(pre.body.expectedVersion, randomUUID(), body); expect(done.status, JSON.stringify(done.body)).toBe(200)
      expect((await control.query("SELECT enabled,source FROM user_namespace_admissions WHERE user_id=$1 AND namespace='attendance'", [target])).rows[0]).toEqual({ enabled: true, source: 'role_unassigned' })
    } finally { await control.query("DELETE FROM role_permissions WHERE role_id='attendance_employee'; DELETE FROM roles WHERE id='attendance_employee'") }
  })
  it('previews and performs scope cleanup when the last namespace admin role is revoked', async () => {
    await control.query("INSERT INTO roles(id,name) VALUES ('attendance_admin','administrator')")
    await control.query("INSERT INTO role_permissions VALUES ('attendance_admin','attendance:admin')")
    await control.query("INSERT INTO user_roles VALUES ($1,'attendance_admin')", [target])
    await control.query("INSERT INTO delegated_role_admin_scopes VALUES ('department-1',$1,'attendance','dept-1',true)", [target])
    await control.query("INSERT INTO delegated_role_admin_member_groups VALUES ('group-1',$1,'attendance','group-x')", [target])
    const priorRevision = randomUUID()
    const otherRevision = randomUUID()
    await control.query("INSERT INTO delegated_role_admin_activation VALUES ($1,'attendance',true,$2),($1,'other',true,$3)", [target, priorRevision, otherRevision])
    const body = { targetUserId: target, action: { kind: 'role.revoke', roleId: 'attendance_admin' }, admissionChanges: [] }
    try {
      const pre = await preview(body); expect(pre.status, JSON.stringify(pre.body)).toBe(200)
      expect(pre.body.impact.scopeCleanup).toEqual([{namespace:'attendance',kind:'department',id:'department-1'},{namespace:'attendance',kind:'member_group',id:'group-1'}])
      const done = await commit(pre.body.expectedVersion, randomUUID(), body); expect(done.status, JSON.stringify(done.body)).toBe(200)
      expect((await control.query('SELECT count(*)::int AS n FROM delegated_role_admin_scopes')).rows[0].n).toBe(0)
      expect((await control.query('SELECT count(*)::int AS n FROM delegated_role_admin_member_groups')).rows[0].n).toBe(0)

      const readActivation = () => control.query('SELECT namespace, enabled, revision FROM delegated_role_admin_activation WHERE admin_user_id=$1 ORDER BY namespace', [target])
      const [disabled, unrelated] = (await readActivation()).rows
      expect(disabled).toMatchObject({ namespace: 'attendance', enabled: false })
      expect(disabled.revision).not.toBe(priorRevision)
      expect(unrelated).toEqual({ namespace: 'other', enabled: true, revision: otherRevision })

      const assign = { ...body, action: { kind: 'role.assign', roleId: 'attendance_admin' } }
      const newAppointment = await preview(assign)
      expect(newAppointment.status, JSON.stringify(newAppointment.body)).toBe(200)
      expect((await commit(newAppointment.body.expectedVersion, randomUUID(), assign)).status).toBe(200)
      const [reappointed] = (await readActivation()).rows
      expect(reappointed).toMatchObject({ namespace: 'attendance', enabled: false })
      expect(reappointed.revision).not.toBe(disabled.revision)

      const repeatAppointment = await preview(assign)
      expect(repeatAppointment.status).toBe(200)
      expect((await commit(repeatAppointment.body.expectedVersion, randomUUID(), assign)).status).toBe(200)
      expect((await readActivation()).rows).toEqual([reappointed, unrelated])
    } finally { await control.query("DELETE FROM role_permissions WHERE role_id='attendance_admin'; DELETE FROM roles WHERE id='attendance_admin'") }
  })

  it('rolls back a revoke if the database does not store the disabled activation', async () => {
    await control.query("INSERT INTO roles(id,name) VALUES ('attendance_admin','administrator')")
    await control.query("INSERT INTO user_roles VALUES ($1,'attendance_admin')", [target])
    const revision = randomUUID()
    await control.query("INSERT INTO delegated_role_admin_activation VALUES ($1,'attendance',true,$2)", [target, revision])
    const body = { targetUserId: target, action: { kind: 'role.revoke', roleId: 'attendance_admin' }, admissionChanges: [] }
    try {
      const pre = await preview(body)
      expect(pre.status, JSON.stringify(pre.body)).toBe(200)
      await control.query(`CREATE FUNCTION keep_activation_enabled() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN NEW.enabled := TRUE; RETURN NEW; END $$;
        CREATE TRIGGER keep_activation_enabled BEFORE UPDATE ON delegated_role_admin_activation
          FOR EACH ROW EXECUTE FUNCTION keep_activation_enabled()`)
      const done = await commit(pre.body.expectedVersion, randomUUID(), body)
      expect(done.status, JSON.stringify(done.body)).toBe(409)
      expect(done.body.error.code).toBe('AUTHORIZATION_INPUT_INCOMPLETE')
      expect((await control.query('SELECT role_id FROM user_roles WHERE user_id=$1', [target])).rows).toEqual([{ role_id: 'attendance_admin' }])
      expect((await control.query('SELECT enabled, revision FROM delegated_role_admin_activation WHERE admin_user_id=$1', [target])).rows).toEqual([{ enabled: true, revision }])
      expect((await control.query('SELECT count(*)::int AS n FROM authorization_operation_audit')).rows[0].n).toBe(0)
    } finally {
      await control.query('DROP TRIGGER IF EXISTS keep_activation_enabled ON delegated_role_admin_activation; DROP FUNCTION IF EXISTS keep_activation_enabled()')
      await control.query("DELETE FROM roles WHERE id='attendance_admin'")
    }
  })

  it('preserves delegation when appointing a canonical role alongside a historical role for the same namespace', async () => {
    const { assignUserRoles } = await import('../../src/rbac/role-assignment')
    await control.query("INSERT INTO roles(id,name) VALUES ('attendance_admin','administrator'),('attendance_admin ','historical administrator')")
    await control.query("INSERT INTO user_roles VALUES ($1,'attendance_admin ')", [target])
    await control.query("INSERT INTO delegated_role_admin_member_groups VALUES ('group-1',$1,'attendance','group-x')", [target])
    const revision = randomUUID()
    await control.query("INSERT INTO delegated_role_admin_activation VALUES ($1,'attendance',true,$2)", [target, revision])
    try {
      await control.query('BEGIN')
      try {
        // The command plan refuses historical noncanonical role ids. Exercise the shared
        // writer directly, as the existing platform member-role route does.
        const result = await assignUserRoles({
          userIds: [target], roleId: 'attendance_admin', scope: { kind: 'platform-admin' },
          executor: { query: (sql, params) => control.query(sql, params) },
        })
        expect(result.affectedUserIds).toEqual([target])
        expect(result.delegatedAdminScopeCleanup).toEqual([])
        await control.query('COMMIT')
      } catch (error) {
        await control.query('ROLLBACK')
        throw error
      }
      expect((await control.query('SELECT enabled, revision FROM delegated_role_admin_activation WHERE admin_user_id=$1', [target])).rows).toEqual([{ enabled: true, revision }])
      expect((await control.query('SELECT id FROM delegated_role_admin_member_groups WHERE admin_user_id=$1', [target])).rows).toEqual([{ id: 'group-1' }])
    } finally {
      await control.query("DELETE FROM roles WHERE id IN ('attendance_admin', 'attendance_admin ')")
    }
  })
  it('serializes concurrent same-key requests and keeps receipts actor-bound', async () => {
    const pre = await preview(); const id = randomUUID()
    const [a,b] = await Promise.all([commit(pre.body.expectedVersion,id),commit(pre.body.expectedVersion,id,{...base,reason:'different'})])
    expect([a.status,b.status].sort()).toEqual([200,409])
    const differentActor = await request(app).get(`${path}/${id}`).auth(token(other), { type: 'bearer' })
    expect(differentActor.status).toBe(200); expect(differentActor.body.status).toBe('unknown_or_pending')
    expect((await control.query('SELECT count(*)::int AS n FROM authorization_operation_receipts')).rows[0].n).toBe(1)
  })
  it('allows independent admission changes and forbids self-widening', async () => {
    const body = { targetUserId: target, action: { kind: 'admission.set' }, admissionChanges: [{namespace:'attendance',enabled:false}] }
    const pre = await preview(body); expect(pre.status).toBe(200)
    const done = await commit(pre.body.expectedVersion, randomUUID(), body); expect(done.status).toBe(200)
    const self = await preview({ ...base, targetUserId: actor }); expect(self.status).toBe(403); expect(self.body.error.code).toBe('SELF_WIDENING_FORBIDDEN')
  })

  it('rechecks role contents after waiting for the role row', async () => {
    const pre = await preview(); expect(pre.status).toBe(200)
    const holder = new Client({ connectionString: url, options: `-c search_path=${schema}` })
    await holder.connect(); await holder.query('BEGIN')
    await holder.query("SELECT id FROM roles WHERE id='attendance_member' FOR UPDATE")
    const pending = commit(pre.body.expectedVersion, randomUUID()).then(value => value)
    try {
      await waitForAnyLockWaiter()
      await holder.query("INSERT INTO role_permissions VALUES ('attendance_member','attendance:write')")
      await holder.query("UPDATE roles SET updated_at=now() WHERE id='attendance_member'")
    } finally { await holder.query('COMMIT'); await holder.end() }
    try {
      const result = await pending; expect(result.status).toBe(409); expect(result.body.error.code).toBe('STALE_PREVIEW')
      expect((await control.query('SELECT count(*)::int AS n FROM authorization_operation_receipts')).rows[0].n).toBe(0)
    } finally { await control.query("DELETE FROM role_permissions WHERE permission_code='attendance:write'") }
  })
  it('refuses a recycled target and refuses later receipt access if the target becomes recycled', async () => {
    const pre = await preview(); expect(pre.status).toBe(200)
    await control.query('UPDATE users SET deleted_at=now() WHERE id=$1', [target])
    const rejected = await commit(pre.body.expectedVersion, randomUUID())
    expect(rejected.status).toBe(404)
    await control.query('UPDATE users SET deleted_at=NULL WHERE id=$1', [target])
    const fresh = await preview(); const id = randomUUID(); expect((await commit(fresh.body.expectedVersion,id)).status).toBe(200)
    await control.query('UPDATE users SET deleted_at=now() WHERE id=$1', [target])
    const lookup = await request(app).get(`${path}/${id}`).auth(token(actor), { type: 'bearer' })
    expect(lookup.status).toBe(404)
  })
  it('rolls back role and scope changes when scope cleanup fails', async () => {
    await control.query("INSERT INTO roles(id,name) VALUES ('attendance_admin','administrator')")
    await control.query("INSERT INTO role_permissions VALUES ('attendance_admin','attendance:admin')")
    await control.query("INSERT INTO user_roles VALUES ($1,'attendance_admin')", [target])
    await control.query("INSERT INTO delegated_role_admin_scopes VALUES ('department-1',$1,'attendance','dept-1',true)", [target])
    await control.query(`CREATE FUNCTION fail_scope_cleanup() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic cleanup failure'; END $$; CREATE TRIGGER fail_scope BEFORE DELETE ON delegated_role_admin_scopes FOR EACH ROW EXECUTE FUNCTION fail_scope_cleanup()`)
    const body = { targetUserId: target, action: { kind: 'role.revoke', roleId: 'attendance_admin' }, admissionChanges: [] }
    try {
      const pre = await preview(body); expect(pre.status).toBe(200)
      const done = await commit(pre.body.expectedVersion, randomUUID(), body); expect(done.status).toBe(503)
      expect((await control.query("SELECT count(*)::int AS n FROM user_roles WHERE user_id=$1 AND role_id='attendance_admin'", [target])).rows[0].n).toBe(1)
      expect((await control.query('SELECT count(*)::int AS n FROM delegated_role_admin_scopes')).rows[0].n).toBe(1)
      expect((await control.query('SELECT count(*)::int AS n FROM authorization_operation_receipts')).rows[0].n).toBe(0)
    } finally { await control.query("DROP TRIGGER fail_scope ON delegated_role_admin_scopes; DROP FUNCTION fail_scope_cleanup(); DELETE FROM role_permissions WHERE role_id='attendance_admin'; DELETE FROM roles WHERE id='attendance_admin'") }
  })
  it('rolls back all writes on a deferred COMMIT failure and reports an unknown outcome', async () => {
    await control.query(`CREATE FUNCTION fail_operation_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic commit failure'; END $$; CREATE CONSTRAINT TRIGGER fail_commit AFTER INSERT ON authorization_operation_audit DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fail_operation_commit()`)
    try {
      const pre = await preview(); expect(pre.status).toBe(200)
      const done = await commit(pre.body.expectedVersion, randomUUID()); expect(done.status).toBe(503)
      expect(done.body.error.code).toBe('AUTHORIZATION_OPERATION_OUTCOME_UNKNOWN')
      expect((await control.query("SELECT count(*)::int AS n FROM user_roles WHERE user_id=$1 AND role_id='attendance_member'", [target])).rows[0].n).toBe(0)
      expect((await control.query('SELECT count(*)::int AS n FROM authorization_operation_receipts')).rows[0].n).toBe(0)
    } finally { await control.query('DROP TRIGGER fail_commit ON authorization_operation_audit; DROP FUNCTION fail_operation_commit()') }
  })

  it('refuses a role membership plan that changed while waiting even if its state returns to the preview', async () => {
    await control.query("INSERT INTO roles(id,name) VALUES ('bare_role','bare')")
    await control.query("INSERT INTO user_roles VALUES ($1,'bare_role')", [target])
    const pre = await preview(); expect(pre.status).toBe(200)
    await control.query("DELETE FROM user_roles WHERE user_id=$1 AND role_id='bare_role'", [target])
    const holder = new Client({ connectionString: url, options: `-c search_path=${schema}` })
    await holder.connect(); await holder.query('BEGIN')
    await holder.query("SELECT pg_advisory_xact_lock(hashtextextended('user-recycle:platform-admin', 0))")
    const pending = commit(pre.body.expectedVersion, randomUUID()).then(value => value)
    try { await waitForLockWaiter(); await holder.query("INSERT INTO user_roles VALUES ($1,'bare_role')", [target]) }
    finally { await holder.query('COMMIT'); await holder.end() }
    try {
      const result = await pending; expect(result.status).toBe(409); expect(result.body.error.code).toBe('STALE_PREVIEW')
    } finally { await control.query("DELETE FROM roles WHERE id='bare_role'") }
  })
  it('rejects a suppressed role write even when it carries no permission codes', async () => {
    await control.query("INSERT INTO roles(id,name) VALUES ('bare_role','bare')")
    await control.query(`CREATE FUNCTION suppress_role() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.role_id='bare_role' THEN RETURN NULL; END IF; RETURN NEW; END $$; CREATE TRIGGER suppress_role BEFORE INSERT ON user_roles FOR EACH ROW EXECUTE FUNCTION suppress_role()`)
    const body = { targetUserId: target, action: { kind: 'role.assign', roleId: 'bare_role' }, admissionChanges: [] }
    try {
      const pre = await preview(body); expect(pre.status).toBe(200)
      const done = await commit(pre.body.expectedVersion, randomUUID(), body); expect(done.status).toBe(409)
      expect((await control.query('SELECT count(*)::int AS n FROM authorization_operation_receipts')).rows[0].n).toBe(0)
    } finally { await control.query("DROP TRIGGER suppress_role ON user_roles; DROP FUNCTION suppress_role(); DELETE FROM roles WHERE id='bare_role'") }
  })
  it('rejects a suppressed admission write even without effective permissions', async () => {
    await control.query(`CREATE FUNCTION suppress_admission() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$; CREATE TRIGGER suppress_admission BEFORE INSERT ON user_namespace_admissions FOR EACH ROW EXECUTE FUNCTION suppress_admission()`)
    const body = { targetUserId: target, action: { kind: 'admission.set' }, admissionChanges: [{ namespace: 'attendance', enabled: true }] }
    try {
      const pre = await preview(body); expect(pre.status).toBe(200)
      const done = await commit(pre.body.expectedVersion, randomUUID(), body); expect(done.status).toBe(409)
      expect((await control.query('SELECT count(*)::int AS n FROM authorization_operation_receipts')).rows[0].n).toBe(0)
    } finally { await control.query('DROP TRIGGER suppress_admission ON user_namespace_admissions; DROP FUNCTION suppress_admission()') }
  })
  it('rejects a suppressed admin-profile synchronization', async () => {
    await control.query(`CREATE FUNCTION suppress_profile() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='${target}' THEN NEW.is_admin=false; END IF; RETURN NEW; END $$; CREATE TRIGGER suppress_profile BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION suppress_profile()`)
    const body = { targetUserId: target, action: { kind: 'role.assign', roleId: 'admin' }, admissionChanges: [] }
    try {
      const pre = await preview(body); expect(pre.status).toBe(200)
      const done = await commit(pre.body.expectedVersion, randomUUID(), body); expect(done.status).toBe(409)
      expect((await control.query("SELECT count(*)::int AS n FROM user_roles WHERE user_id=$1 AND role_id='admin'", [target])).rows[0].n).toBe(0)
    } finally { await control.query('DROP TRIGGER suppress_profile ON users; DROP FUNCTION suppress_profile()') }
  })
  it('rejects a suppressed scope removal and rolls back the role revoke', async () => {
    await control.query("INSERT INTO roles(id,name) VALUES ('attendance_admin','administrator')")
    await control.query("INSERT INTO role_permissions VALUES ('attendance_admin','attendance:admin')")
    await control.query("INSERT INTO user_roles VALUES ($1,'attendance_admin')", [target])
    await control.query("INSERT INTO delegated_role_admin_scopes VALUES ('department-1',$1,'attendance','dept-1',true)", [target])
    await control.query(`CREATE FUNCTION suppress_scope() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$; CREATE TRIGGER suppress_scope BEFORE DELETE ON delegated_role_admin_scopes FOR EACH ROW EXECUTE FUNCTION suppress_scope()`)
    const body = { targetUserId: target, action: { kind: 'role.revoke', roleId: 'attendance_admin' }, admissionChanges: [] }
    try {
      const pre = await preview(body); expect(pre.status).toBe(200)
      const done = await commit(pre.body.expectedVersion, randomUUID(), body); expect(done.status).toBe(409)
      expect((await control.query("SELECT count(*)::int AS n FROM user_roles WHERE user_id=$1 AND role_id='attendance_admin'", [target])).rows[0].n).toBe(1)
    } finally { await control.query("DROP TRIGGER suppress_scope ON delegated_role_admin_scopes; DROP FUNCTION suppress_scope(); DELETE FROM role_permissions WHERE role_id='attendance_admin'; DELETE FROM roles WHERE id='attendance_admin'") }
  })

  it('rejects unexpected effective-permission changes caused during a role write', async () => {
    await control.query(`CREATE FUNCTION add_unexpected_grant() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.role_id='attendance_member' THEN INSERT INTO user_permissions VALUES (NEW.user_id,'rogue:read'); END IF; RETURN NEW; END $$; CREATE TRIGGER add_grant AFTER INSERT ON user_roles FOR EACH ROW EXECUTE FUNCTION add_unexpected_grant()`)
    try {
      const pre = await preview(); expect(pre.status).toBe(200)
      const done = await commit(pre.body.expectedVersion, randomUUID()); expect(done.status).toBe(409)
      expect((await control.query('SELECT count(*)::int AS n FROM user_permissions')).rows[0].n).toBe(0)
    } finally { await control.query('DROP TRIGGER add_grant ON user_roles; DROP FUNCTION add_unexpected_grant()') }
  })
  it('rejects lost opt-out provenance even when the admission remains enabled', async () => {
    await control.query("INSERT INTO roles(id,name) VALUES ('attendance_employee','employee')")
    await control.query("INSERT INTO role_permissions VALUES ('attendance_employee','attendance:read')")
    await control.query("INSERT INTO user_roles VALUES ($1,'attendance_member'),($1,'attendance_employee')", [target])
    await control.query("INSERT INTO user_namespace_admissions (user_id, namespace, enabled, source) VALUES ($1,'attendance',true,'platform_admin')", [target])
    await control.query(`CREATE FUNCTION corrupt_optout_source() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.source='unexpected'; RETURN NEW; END $$; CREATE TRIGGER corrupt_optout BEFORE UPDATE ON user_namespace_admissions FOR EACH ROW EXECUTE FUNCTION corrupt_optout_source()`)
    const body = { targetUserId: target, action: { kind: 'role.revoke', roleId: 'attendance_employee' }, admissionChanges: [] }
    try {
      const pre = await preview(body); expect(pre.status).toBe(200)
      const done = await commit(pre.body.expectedVersion, randomUUID(), body); expect(done.status).toBe(409)
      expect((await control.query("SELECT count(*)::int AS n FROM user_roles WHERE user_id=$1 AND role_id='attendance_employee'", [target])).rows[0].n).toBe(1)
    } finally { await control.query("DROP TRIGGER corrupt_optout ON user_namespace_admissions; DROP FUNCTION corrupt_optout_source(); DELETE FROM role_permissions WHERE role_id='attendance_employee'; DELETE FROM roles WHERE id='attendance_employee'") }
  })
  it('rejects missing role rows and conflicting derived admission changes', async () => {
    const missing = { targetUserId: target, action: { kind: 'role.assign', roleId: 'missing_role' }, admissionChanges: [] }
    expect((await preview(missing)).status).toBe(409)
    await control.query("INSERT INTO user_roles VALUES ($1,'attendance_member')", [target])
    const conflicting = { targetUserId: target, action: { kind: 'role.revoke', roleId: 'attendance_member' }, admissionChanges: [{ namespace: 'attendance', enabled: true }] }
    const result = await preview(conflicting); expect(result.status).toBe(400); expect(result.body.error.code).toBe('ADMISSION_CONFLICT')
  })
  it('refuses to demote the last sign-in-capable administrator', async () => {
    await control.query("DELETE FROM user_roles WHERE user_id=$1 AND role_id='admin'", [other])
    await control.query("UPDATE users SET role='user',is_admin=false WHERE id=$1", [other])
    const body = { targetUserId: actor, action: { kind: 'role.revoke', roleId: 'admin' }, admissionChanges: [] }
    const pre = await preview(body); expect(pre.status).toBe(200)
    const done = await commit(pre.body.expectedVersion, randomUUID(), body); expect(done.status).toBe(409); expect(done.body.error.code).toBe('LAST_PLATFORM_ADMIN')
  })
  it('rejects an oversized witness rather than returning a partial preview', async () => {
    await control.query("INSERT INTO user_permissions SELECT $1, 'fixture:' || n FROM generate_series(1,1001) n", [target])
    const result = await preview(); expect(result.status).toBe(503); expect(result.body.error.code).toBe('AUTHORIZATION_OPERATION_UNAVAILABLE')
  })

  it('rejects an unrelated role membership added by a write side effect', async () => {
    await control.query("INSERT INTO roles(id,name) VALUES ('bare_role','bare')")
    await control.query(`CREATE FUNCTION add_unexpected_role() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.role_id='attendance_member' THEN INSERT INTO user_roles VALUES (NEW.user_id,'bare_role'); END IF; RETURN NEW; END $$; CREATE TRIGGER add_role AFTER INSERT ON user_roles FOR EACH ROW EXECUTE FUNCTION add_unexpected_role()`)
    try {
      const pre = await preview(); expect(pre.status).toBe(200)
      const done = await commit(pre.body.expectedVersion, randomUUID()); expect(done.status).toBe(409)
      expect((await control.query("SELECT count(*)::int AS n FROM user_roles WHERE user_id=$1", [target])).rows[0].n).toBe(0)
    } finally { await control.query("DROP TRIGGER add_role ON user_roles; DROP FUNCTION add_unexpected_role(); DELETE FROM roles WHERE id='bare_role'") }
  })
  it('rejects an unrelated admission changed by a write side effect', async () => {
    await control.query("INSERT INTO user_namespace_admissions (user_id,namespace,enabled,source) VALUES ($1,'plm',false,'platform_admin')", [target])
    await control.query(`CREATE FUNCTION change_unexpected_admission() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.namespace='attendance' THEN UPDATE user_namespace_admissions SET source='unexpected' WHERE user_id=NEW.user_id AND namespace='plm'; END IF; RETURN NEW; END $$; CREATE TRIGGER change_admission AFTER INSERT ON user_namespace_admissions FOR EACH ROW EXECUTE FUNCTION change_unexpected_admission()`)
    try {
      const pre = await preview(); expect(pre.status).toBe(200)
      const done = await commit(pre.body.expectedVersion, randomUUID()); expect(done.status).toBe(409)
      expect((await control.query("SELECT source FROM user_namespace_admissions WHERE user_id=$1 AND namespace='plm'", [target])).rows[0].source).toBe('platform_admin')
    } finally { await control.query('DROP TRIGGER change_admission ON user_namespace_admissions; DROP FUNCTION change_unexpected_admission()') }
  })
  it('rejects unrelated scope cleanup caused by a role revoke', async () => {
    await control.query("INSERT INTO roles(id,name) VALUES ('attendance_admin','administrator')")
    await control.query("INSERT INTO role_permissions VALUES ('attendance_admin','attendance:admin')")
    await control.query("INSERT INTO user_roles VALUES ($1,'attendance_admin')", [target])
    await control.query("INSERT INTO delegated_role_admin_scopes VALUES ('department-1',$1,'attendance','dept-1',true),('department-2',$1,'plm','dept-2',true)", [target])
    await control.query(`CREATE FUNCTION delete_unexpected_scope() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.id='department-1' THEN DELETE FROM delegated_role_admin_scopes WHERE id='department-2'; END IF; RETURN OLD; END $$; CREATE TRIGGER delete_scope AFTER DELETE ON delegated_role_admin_scopes FOR EACH ROW EXECUTE FUNCTION delete_unexpected_scope()`)
    const body = { targetUserId: target, action: { kind: 'role.revoke', roleId: 'attendance_admin' }, admissionChanges: [] }
    try {
      const pre = await preview(body); expect(pre.status).toBe(200)
      const done = await commit(pre.body.expectedVersion, randomUUID(), body); expect(done.status).toBe(409)
      expect((await control.query('SELECT count(*)::int AS n FROM delegated_role_admin_scopes')).rows[0].n).toBe(2)
    } finally { await control.query("DROP TRIGGER delete_scope ON delegated_role_admin_scopes; DROP FUNCTION delete_unexpected_scope(); DELETE FROM role_permissions WHERE role_id='attendance_admin'; DELETE FROM roles WHERE id='attendance_admin'") }
  })

  it('includes platform-admin bypass in effective preview and distinguishes role and raw-profile sources', async () => {
    const assign = { targetUserId: target, action: { kind: 'role.assign', roleId: 'admin' }, admissionChanges: [] }
    const pre = await preview(assign); expect(pre.status).toBe(200)
    expect(pre.body.impact.effectiveAfter).toEqual([{ code: '*:*', sources: [{ kind:'profile', id:null }, { kind:'role', id:'admin' }], effective:true }])
    const done = await commit(pre.body.expectedVersion, randomUUID(), assign); expect(done.status, JSON.stringify(done.body)).toBe(200)
    expect(done.body.receipt.impact.effectiveAfter).toEqual(pre.body.impact.effectiveAfter)
  })
  it('previews and removes a raw-only admin profile as a wildcard source', async () => {
    await control.query("UPDATE users SET role='admin', is_admin=true WHERE id=$1", [target])
    const body = { targetUserId: target, action: { kind: 'role.revoke', roleId: 'admin' }, admissionChanges: [] }
    const pre = await preview(body); expect(pre.status).toBe(200)
    expect(pre.body.impact.effectiveBefore).toEqual([{ code:'*:*',sources:[{kind:'profile',id:null}],effective:true }])
    expect(pre.body.impact.effectiveAfter).toEqual([])
    const done = await commit(pre.body.expectedVersion, randomUUID(), body); expect(done.status, JSON.stringify(done.body)).toBe(200)
  })

  it('shows raw-profile admin bypass for a normally admission-masked grant', async () => {
    await control.query("UPDATE users SET role='admin' WHERE id=$1", [target])
    await control.query("INSERT INTO user_permissions VALUES ($1,'attendance:read')", [target])
    const pre = await preview({ targetUserId: target, action: { kind: 'admission.set' }, admissionChanges: [{ namespace:'attendance',enabled:false }] })
    expect(pre.status).toBe(200)
    expect(pre.body.impact.effectiveBefore.find((item: {code:string}) => item.code === 'attendance:read').effective).toBe(true)
  })
  it('shows RBAC admin bypass for a normally admission-masked grant', async () => {
    await control.query("INSERT INTO user_roles VALUES ($1,'admin')", [target])
    await control.query("INSERT INTO user_permissions VALUES ($1,'attendance:read')", [target])
    const pre = await preview({ targetUserId: target, action: { kind: 'admission.set' }, admissionChanges: [{ namespace:'attendance',enabled:false }] })
    expect(pre.status).toBe(200)
    expect(pre.body.impact.effectiveBefore.find((item: {code:string}) => item.code === 'attendance:read').effective).toBe(true)
  })

  it.each([{ who: 'actor', status: 403 }, { who: 'target', status: 404 }])('refuses a missing locked $who before further reads', async ({ who, status }) => {
    const pre = await preview(); expect(pre.status).toBe(200)
    const holder = new Client({ connectionString: url, options: `-c search_path=${schema}` })
    await holder.connect(); await holder.query('BEGIN')
    await holder.query("SELECT pg_advisory_xact_lock(hashtextextended('user-recycle:platform-admin', 0))")
    const pending = commit(pre.body.expectedVersion, randomUUID()).then(value => value)
    try { await waitForLockWaiter(); await holder.query('DELETE FROM users WHERE id=$1', [who === 'actor' ? actor : target]) }
    finally { await holder.query('COMMIT'); await holder.end() }
    const result = await pending; expect(result.status).toBe(status)
    expect((await control.query('SELECT count(*)::int AS n FROM authorization_operation_receipts')).rows[0].n).toBe(0)
  })

  })
})

})
