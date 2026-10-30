import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getRequestContext } from '../../src/context/request-context'
import { createOnlinePunchDbFixture } from '../utils/attendance-online-punch-db'

// Derived W6 admission proof on the canonical real server and DB-backed auth.
// No injected principal, mocked RBAC, trusted claims or provider/customer data.
if (!process.env.ATTENDANCE_TEST_DATABASE_URL || !process.env.DATABASE_URL) {
  throw new Error('W6_AUTH_FIVE_REAL_DATABASE_REQUIRED')
}
if (process.env.ATTENDANCE_TEST_DATABASE_URL !== process.env.DATABASE_URL) {
  throw new Error('W6_AUTH_FIVE_DATABASE_BINDING_REQUIRED')
}
if (process.env.RBAC_OPTIONAL === '1') throw new Error('W6_AUTH_FIVE_STRICT_RBAC_REQUIRED')

const f = createOnlinePunchDbFixture({ retainHistoryInIsolatedDatabase: true })
const namespace = 'w6_auth_five_' + randomUUID().replaceAll('-', '')
const orgB = randomUUID()
const readerRole = namespace + '_reader'
const delegatedRole = namespace + '_delegate'
type Actor = { userId: string; token: string; sessionId: string; orgId: string; name: string; email: string }
type Statement = { sql: string; params: readonly unknown[]; userId?: string; tenantId?: string }
type Fingerprint = { table: string; rows: string; fingerprint: string }
type Baseline = { business: Fingerprint[]; auth: Fingerprint[] }
const traces = new Map<string, Statement[]>()
const originalQuery = Client.prototype.query
let requestCount = 0
let groupId = ''
let a: Actor
let b: Actor
let owner: Actor
let tables: string[] = []

// Observe the existing request scope only. Forward the exact original receiver,
// arguments, callback/promise and return value; no replacement query or result.
const observedQuery = function (this: Client, ...args: unknown[]) {
  const context = getRequestContext()
  const trace = context && traces.get(context.correlationId)
  if (context && trace) {
    const first = args[0]
    const config = first && typeof first === 'object' ? first as { text?: unknown; values?: unknown } : null
    const text = typeof first === 'string' ? first : config?.text
    const params = Array.isArray(args[1]) ? args[1] : Array.isArray(config?.values) ? config.values : []
    trace.push({ sql: typeof text === 'string' ? text : 'UNOBSERVABLE_QUERY',
      params: [...params], userId: context.userId, tenantId: context.tenantId })
  }
  return Reflect.apply(originalQuery, this, args)
} as typeof Client.prototype.query

function writeTargets(sql: string): string[] {
  // Literal/comment contents are not commands. Retain writable CTEs. A row
  // lock is not DML; unknown write/DDL is never classified as an auth touch.
  const code = sql.replace(/'(?:''|[^'])*'/g, "''")
    .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ')
    .replace(/\bFOR\s+(?:NO\s+KEY\s+)?UPDATE(?:\s+OF\s+[\w".,\s]+)?/gi, ' ')
  const targets = [...code.matchAll(/\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|MERGE\s+INTO|TRUNCATE(?:\s+TABLE)?)\s+(?:public\.)?"?([a-z_][a-z0-9_]*)"?/gi)]
    .map(match => match[1].toLowerCase())
  if (/\b(?:CREATE|ALTER|DROP|GRANT|REVOKE|COPY)\b/i.test(code)) targets.push('non_auth_ddl_or_copy')
  if (/\b(?:INSERT|UPDATE|DELETE|MERGE|TRUNCATE)\b/i.test(code) && targets.length === 0) targets.push('unclassified_write')
  return targets
}

async function snapshots(): Promise<Baseline> {
  const business: Fingerprint[] = []
  const auth: Fingerprint[] = []
  for (const table of tables) {
    const qualified = '"public"."' + table.replaceAll('"', '""') + '"'
    const result = await f.pool.query<{ rows: string; fingerprint: string }>(
      'SELECT count(*)::text AS rows, md5(COALESCE(string_agg(to_jsonb(t)::text || \':\' || t.xmin::text, ' +
      "E'\\n' ORDER BY to_jsonb(t)::text,t.xmin::text),'')) AS fingerprint FROM " + qualified + ' t',
    )
    const item = { table, ...result.rows[0] }
    if (table === 'user_sessions' || table === 'user_session_revocations') auth.push(item)
    else business.push(item)
  }
  return { business, auth }
}

async function assertProfile(actor: Actor, delegated: boolean) {
  const response = await f.request('/api/auth/me', actor.token, undefined, 'GET')
  expect(response.status, JSON.stringify(response.body)).toBe(200)
  const profile = response.body.data.user
  expect({ id: profile.id, name: profile.name, email: profile.email, role: profile.role,
    tenantId: profile.tenantId, isActive: profile.is_active, activation: profile.activation_status,
    localPassword: profile.local_password_set, mustChangePassword: profile.must_change_password })
    .toEqual({ id: actor.userId, name: actor.name, email: actor.email, role: 'user',
      tenantId: actor.orgId, isActive: true, activation: 'activated', localPassword: true, mustChangePassword: false })
  expect([...profile.permissions].sort()).toEqual(
    delegated ? ['attendance:admin', 'attendance:read'] : ['attendance:read'],
  )
}

async function seedActor(orgId: string, delegated: boolean): Promise<Actor> {
  const userId = randomUUID()
  const name = 'Synthetic W6 probe person'
  const email = userId + '@w6-auth-five.test'
  // B membership exists BEFORE B's first token/session is minted. Never
  // relabel an old A token as a B session.
  await f.pool.query(
    `INSERT INTO users(id,email,username,name,password_hash,role,permissions,is_active,is_admin,
       activation_status,local_password_set,must_change_password)
     VALUES($1,$2,$1,$3,'disabled','user','[]'::jsonb,true,false,'activated',true,false)`,
    [userId, email, name],
  )
  await f.pool.query('INSERT INTO user_orgs(user_id,org_id,is_active) VALUES($1,$2,true)', [userId, orgId])
  await f.pool.query('INSERT INTO user_roles(user_id,role_id) VALUES($1,$2)', [userId, readerRole])
  if (delegated) await f.pool.query('INSERT INTO user_roles(user_id,role_id) VALUES($1,$2)', [userId, delegatedRole])
  await f.pool.query(
    "INSERT INTO user_namespace_admissions(user_id,namespace,enabled,source) VALUES($1,'attendance',true,'test_fixture')",
    [userId],
  )
  expect((await f.pool.query(
    'SELECT org_id,is_active FROM user_orgs WHERE user_id=$1 ORDER BY org_id', [userId],
  )).rows).toEqual([{ org_id: orgId, is_active: true }])
  const query = new URLSearchParams({ userId, tenantId: orgId, roles: 'viewer', perms: 'attendance:read' })
  const minted = await f.request('/api/auth/dev-token?' + query, undefined, undefined, 'GET')
  expect(minted.status).toBe(200)
  expect(typeof minted.body.token).toBe('string')
  expect({ id: minted.body.payload.id, tenantId: minted.body.payload.tenantId,
    roles: minted.body.payload.roles, perms: minted.body.payload.perms })
    .toEqual({ id: userId, tenantId: orgId, roles: ['viewer'], perms: ['attendance:read'] })
  const sessionId = minted.body.payload.sid as string
  expect((await f.pool.query(
    'SELECT user_id,revoked_at FROM user_sessions WHERE id=$1', [sessionId],
  )).rows).toEqual([{ user_id: userId, revoked_at: null }])
  const actor = { userId, orgId, token: minted.body.token as string, sessionId, name, email }
  await assertProfile(actor, delegated)
  return actor
}

async function measuredGet(caseId: string, actor: Actor, expectedStatus: number, extraHeaders: Record<string, string> = {}) {
  if (requestCount >= 5) throw new Error('W6_AUTH_FIVE_AGGREGATE_REQUEST_BUDGET_EXCEEDED')
  const before = await snapshots()
  const correlationId = namespace + '_' + caseId
  const trace: Statement[] = []
  traces.set(correlationId, trace)
  requestCount++
  const startedAt = new Date()
  const response = await fetch(f.getBaseUrl() + '/api/attendance/groups/' + groupId + '/effective-policy', {
    method: 'GET',
    headers: { Authorization: 'Bearer ' + actor.token, 'X-Correlation-ID': correlationId, ...extraHeaders },
  })
  const body = await response.json()
  const endedAt = new Date()
  const after = await snapshots()
  expect(response.headers.get('x-correlation-id')).toBe(correlationId)
  expect(response.status, JSON.stringify(body)).toBe(expectedStatus)
  expect(after.business).toEqual(before.business)
  expect(trace.some(row => row.sql === 'UNOBSERVABLE_QUERY')).toBe(false)
  // Real profile/session SELECTs are positive controls for the wire observer.
  expect(trace.some(row => /\bFROM\s+users\b/i.test(row.sql) && row.params.includes(actor.userId))).toBe(true)
  expect(trace.some(row => /\bFROM\s+user_sessions\b/i.test(row.sql) && row.params.includes(actor.sessionId))).toBe(true)
  const writes = trace.flatMap(row => writeTargets(row.sql))
  const authWrites = writes.filter(table => table === 'user_sessions')
  expect(writes.filter(table => table !== 'user_sessions')).toEqual([])
  const groupReads = trace.filter(row => /\bFROM\s+attendance_groups\b/i.test(row.sql))
  if (caseId === 'A1') {
    expect(groupReads.length).toBeGreaterThan(0)
    expect(groupReads.some(row => row.params[0] === groupId && row.params[1] === f.orgId)).toBe(true)
    expect(trace.some(row => /\bFROM\s+attendance_schedule_groups\b/i.test(row.sql))).toBe(true)
    expect(trace.some(row => /^SET\s+TRANSACTION\s+READ\s+ONLY\b/i.test(row.sql.trim()))).toBe(true)
    expect(groupReads.every(row => row.userId === actor.userId && row.tenantId === f.orgId)).toBe(true)
  } else if (caseId === 'A2') {
    expect(groupReads.length).toBeGreaterThan(0)
    expect(groupReads.every(row => row.params[0] === groupId && row.params[1] === orgB && row.tenantId === orgB)).toBe(true)
  } else {
    // A2 may issue a B-scoped missing-group SELECT. Other denials stop
    // before the first aggregate SELECT; auth/RBAC SQL is still allowed.
    expect(groupReads).toEqual([])
    expect(trace.filter(row => /\bFROM\s+attendance_(?:schedule_groups|rule_sets|group_members|group_managers|calculation_rollout_state|calculation_group_memberships)\b/i.test(row.sql))).toEqual([])
  }
  console.info('W6_AUTH_FIVE_RECEIPT', JSON.stringify({
    caseId, status: response.status, observedSql: trace.length, groupSelects: groupReads.length,
    businessDml: 0, businessTablesCompared: before.business.length,
    authSessionWriteStatements: authWrites.length,
    authSessionFingerprintsChanged: JSON.stringify(before.auth) !== JSON.stringify(after.auth),
  }))
  return { body, startedAt, endedAt }
}

describe.sequential('W6-AUTH-5 real MetaSheetServer/JWT/DB-RBAC admission', () => {
  beforeAll(async () => {
    Client.prototype.query = observedQuery
    const bootstrap = await f.start()
    expect(process.env.RBAC_BYPASS).toBe('false')
    expect(process.env.RBAC_TOKEN_TRUST).toBe('false')
    await f.pool.query(
      "UPDATE users SET activation_status='activated',local_password_set=true,must_change_password=false WHERE id=$1",
      [bootstrap.userId],
    )
    await f.pool.query('INSERT INTO roles(id,name) VALUES($1,$2),($3,$4)',
      [readerRole, namespace + ' reader', delegatedRole, namespace + ' delegate'])
    await f.pool.query(
      "INSERT INTO role_permissions(role_id,permission_code) VALUES($1,'attendance:read'),($2,'attendance:admin')",
      [readerRole, delegatedRole],
    )
    a = await seedActor(f.orgId, true)
    b = await seedActor(orgB, true)
    owner = await seedActor(f.orgId, false)
    const group = await f.request('/api/attendance/groups', bootstrap.token, {
      name: namespace, code: namespace, timezone: 'UTC', attendanceType: 'scheduled_shift',
    })
    expect(group.status, JSON.stringify(group.body)).toBe(200)
    groupId = group.body.data.id
    expect(groupId).toMatch(/^[0-9a-f-]{36}$/)
    const manager = await f.request('/api/attendance/groups/' + groupId + '/managers', bootstrap.token,
      { userId: owner.userId, role: 'owner' })
    expect(manager.status, JSON.stringify(manager.body)).toBe(200)
    expect((await f.pool.query(
      'SELECT user_id,role FROM attendance_group_managers WHERE group_id=$1 AND org_id=$2',
      [groupId, f.orgId],
    )).rows).toEqual([{ user_id: owner.userId, role: 'owner' }])
    // Include all public ordinary business tables and audit/trigger targets.
    // Only session registry/revocation tables are fingerprinted separately.
    const inventory = await f.pool.query<{ name: string }>(
      `SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='public' AND c.relkind IN ('r','p') ORDER BY c.relname`,
    )
    tables = inventory.rows.map(row => row.name)
    for (const required of ['users', 'user_roles', 'role_permissions', 'user_orgs', 'user_namespace_admissions',
      'user_sessions', 'attendance_groups', 'attendance_group_managers', 'attendance_schedule_groups',
      'attendance_rule_sets', 'attendance_calculation_rollout_state']) expect(tables).toContain(required)
  }, 180_000)

  afterAll(async () => {
    try { expect(requestCount).toBe(5) } finally {
      Client.prototype.query = originalQuery
      await f.stop()
    }
  }, 60_000)

  it('A1 delegated admin active A: scheduled needs-configuration 200', async () => {
    const result = await measuredGet('A1', a, 200)
    const fixture = JSON.parse(readFileSync(new URL('../fixtures/attendance/w6/aggregate-needs-configuration.json', import.meta.url), 'utf8'))
    fixture.data.groupId = groupId
    fixture.data.timezone = 'UTC'
    fixture.data.activeMemberCount = 0
    fixture.data.managerPosture = { ownerCount: 1, subOwnerCount: 0 }
    fixture.data.conflicts = fixture.data.conflicts.filter((conflict: { code: string }) => conflict.code !== 'TIMEZONE_MISSING')
    const evaluatedAt = result.body.data.evaluatedAt
    expect(typeof evaluatedAt).toBe('string')
    expect(new Date(evaluatedAt).toISOString()).toBe(evaluatedAt)
    expect(new Date(evaluatedAt).getTime()).toBeGreaterThanOrEqual(result.startedAt.getTime())
    expect(new Date(evaluatedAt).getTime()).toBeLessThanOrEqual(result.endedAt.getTime())
    fixture.data.evaluatedAt = evaluatedAt
    expect(result.body).toEqual(fixture)
  })

  it('A2 real B membership before minting B session: group A 404', async () => {
    expect(b.orgId).toBe(orgB)
    const result = await measuredGet('A2', b, 404)
    expect(result.body).toEqual({ ok: false, error: { code: 'NOT_FOUND', message: 'Group not found' } })
  })

  it('A3 A principal with mismatching x-org B: 403 before aggregate', async () => {
    const result = await measuredGet('A3', a, 403, { 'X-Org-Id': orgB })
    expect(result.body).toEqual({ ok: false, error: { code: 'FORBIDDEN', message: 'Insufficient permissions' } })
  })

  it('A4 real group owner without DB admin permission: RBAC 403', async () => {
    const result = await measuredGet('A4', owner, 403)
    expect(result.body).toEqual({ error: 'Insufficient permissions' })
  })

  it('A5 revoked A membership with unchanged old token: unscoped 403', async () => {
    const oldToken = a.token
    await f.pool.query('UPDATE user_orgs SET is_active=false WHERE user_id=$1 AND org_id=$2', [a.userId, f.orgId])
    expect((await f.pool.query('SELECT org_id,is_active FROM user_orgs WHERE user_id=$1', [a.userId])).rows)
      .toEqual([{ org_id: f.orgId, is_active: false }])
    const me = await f.request('/api/auth/me', oldToken, undefined, 'GET')
    expect(me.status).toBe(200)
    expect({ id: me.body.data.user.id, tenantId: me.body.data.user.tenantId, role: me.body.data.user.role })
      .toEqual({ id: a.userId, tenantId: undefined, role: 'user' })
    expect(a.token).toBe(oldToken)
    const result = await measuredGet('A5', a, 403)
    expect(result.body).toEqual({ ok: false, error: { code: 'FORBIDDEN', message: 'Authenticated organization not found' } })
  })
})
