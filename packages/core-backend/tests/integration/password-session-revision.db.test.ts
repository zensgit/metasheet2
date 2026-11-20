import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import * as bcrypt from 'bcryptjs'
import express from 'express'
import { Client } from 'pg'
import request from 'supertest'
import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import { authService } from '../../src/auth/AuthService'
import { issueInviteToken } from '../../src/auth/invite-tokens'
import { jwtAuthMiddleware } from '../../src/auth/jwt-middleware'
import { query } from '../../src/db/pg'
import { validateStrictSession } from '../../src/rbac/strict-principal'
import { authRouter } from '../../src/routes/auth'
import { usePinnedServer } from '../utils/pinned-server'

const server = usePinnedServer()
const app = express()
app.use(express.json())
app.post('/api/auth/password/change', jwtAuthMiddleware)
app.use('/api/auth', authRouter)
app.get('/api/synthetic-member', jwtAuthMiddleware, (_req, res) => res.sendStatus(204))
server.setApp(app)

beforeAll(async () => {
  const url = new URL(process.env.DATABASE_URL || 'invalid:')
  const socket = url.searchParams.get('host')
  if (!['localhost', '127.0.0.1'].includes(url.hostname) || url.pathname !== '/admin_review_synthetic_delivery'
    || [...url.searchParams.keys()].some(key => key !== 'host') || (socket && !socket.startsWith('/tmp/manual-delivery.'))
    || process.env.EXPECT_DB !== '1') throw new Error('Dedicated synthetic database required')
  expect((await query('SELECT current_database() AS name')).rows[0].name).toBe('admin_review_synthetic_delivery')
})

afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks() })

const selfService = ['attendance:read', 'attendance:write']
const attendanceCodes = (codes: string[] | undefined) => codes?.filter(code => code.startsWith('attendance:')).sort()
const currentRoles = async (id: string) => (await query<{ role_id: string }>(
  'SELECT role_id FROM user_roles WHERE user_id=$1 ORDER BY role_id', [id],
)).rows.map(row => row.role_id)

it.each(['platform', 'attendance-focused'])('registers with only the intended durable grants in %s', async mode => {
  vi.stubEnv('PRODUCT_MODE', mode)
  const result = await request(server.url()).post('/api/auth/register').send({
    email: `signup_${randomUUID()}@example.test`, password: 'Local-Synthetic-9!', name: 'Synthetic member',
  })
  expect(result.status).toBe(201)
  const { user, token } = result.body.data
  expect(authService.readTokenPayload(token)?.sid).toBeUndefined()
  const expected = mode === 'platform' ? [] : selfService
  expect(attendanceCodes(user.permissions)).toEqual(expected)
  const stored = await query('SELECT permissions FROM users WHERE id=$1', [user.id])
  expect(attendanceCodes(stored.rows[0].permissions)).toEqual(expected)
  const direct = await query('SELECT permission_code FROM user_permissions WHERE user_id=$1', [user.id])
  expect(attendanceCodes(direct.rows.map(row => row.permission_code))).toEqual(expected)
  expect(attendanceCodes((await authService.verifyToken(token))?.permissions)).toEqual(expected)
  expect(await currentRoles(user.id)).toEqual(mode === 'platform' ? [] : ['attendance_employee'])
})

it.each([
  ['platform', null, null, [], []],
  ['platform', true, 'admin_create', [], []],
  ['platform', null, null, ['attendance_employee'], selfService],
  ['platform', true, 'admin_create', ['attendance_employee'], selfService],
  ['platform', false, 'platform_admin', ['attendance_employee'], []],
  ['platform', true, 'role_unassigned', ['attendance_approver'], ['attendance:approve', 'attendance:read']],
  ['attendance', false, 'role_unassigned', [], []],
  ['attendance', null, null, [], selfService],
] as const)('accepts an invitation under %s / %s / %s / %j without restoring revoked roles', async (mode, enabled, source, roles, expected) => {
  vi.stubEnv('PRODUCT_MODE', mode)
  const id = `inv_${randomUUID()}`
  const email = `${id}@example.test`
  await query(`INSERT INTO users(id,email,name,password_hash,role,is_active,activation_status,local_password_set,updated_at)
    VALUES ($1,$2,'Synthetic','not-a-login-hash','user',true,'activated',false,now()-interval '1 day')`, [id,email])
  for (const role of roles) await query('INSERT INTO user_roles(user_id,role_id) VALUES ($1,$2)', [id,role])
  if (enabled !== null) await query(`INSERT INTO user_namespace_admissions(user_id,namespace,enabled,source)
    VALUES ($1,'attendance',$2,$3)`, [id,enabled,source])
  if (enabled === false) await query(`UPDATE users SET permissions='["attendance:write"]'::jsonb WHERE id=$1`, [id])
  const presetId = source === 'admin_create' && roles.length ? 'attendance-employee' : null
  const token = issueInviteToken({ userId: id, email, presetId })
  await query('INSERT INTO user_invites(user_id,email,preset_id,invite_token,product_mode,invited_by) VALUES ($1,$2,$3,$4,$5,$1)', [id,email,presetId,token,mode])
  const accepted = await request(server.url()).post('/api/auth/invite/accept').send({ token, password: 'Synthetic-Invite-9!' })
  expect(accepted.status).toBe(200)
  expect(attendanceCodes(accepted.body.data.user.permissions)).toEqual(expected)
  const session = accepted.body.data.token
  expect(attendanceCodes((await authService.verifyToken(session))?.permissions)).toEqual(expected)
  const refreshed = await authService.refreshToken(session)
  expect(typeof refreshed).toBe('string')
  expect(attendanceCodes((await authService.verifyToken(refreshed!))?.permissions)).toEqual(expected)
  expect(await currentRoles(id)).toEqual(mode === 'attendance' && enabled === null ? ['attendance_employee'] : roles)
})

it('does not grant attendance or undo invite consumption if automatic login fails', async () => {
  vi.stubEnv('PRODUCT_MODE', 'attendance')
  const id = `consumed_${randomUUID()}`
  const email = `${id}@example.test`
  await query(`INSERT INTO users(id,email,name,password_hash,role,is_active,activation_status,local_password_set,updated_at)
    VALUES ($1,$2,'Synthetic','not-a-login-hash','user',true,'activated',false,now()-interval '1 day')`, [id,email])
  const token = issueInviteToken({ userId: id, email })
  await query(`INSERT INTO user_invites(user_id,email,invite_token,product_mode,invited_by) VALUES ($1,$2,$3,'attendance',$1)`, [id,email,token])
  vi.spyOn(authService, 'login').mockResolvedValueOnce(null)
  const response = await request(server.url()).post('/api/auth/invite/accept').send({ token, password: 'Synthetic-Invite-9!' })
  expect(response.status).toBe(500)
  expect((await query('SELECT status FROM user_invites WHERE user_id=$1', [id])).rows).toEqual([{ status: 'accepted' }])
  expect(await currentRoles(id)).toEqual([])
})

it('does not bootstrap on rejected session verification or renewal in dedicated mode', async () => {
  vi.stubEnv('PRODUCT_MODE', 'platform')
  const id = `rejected_${randomUUID()}`
  const email = `${id}@example.test`
  const password = 'Local-Synthetic-9!'
  await query(`INSERT INTO users(id,email,name,password_hash,role,is_active,activation_status,local_password_set)
    VALUES ($1,$2,'Synthetic',$3,'user',true,'activated',true)`, [id,email,await bcrypt.hash(password,4)])
  const result = await authService.login(email,password)
  expect(result).not.toBeNull()
  await query('UPDATE user_sessions SET revoked_at=now() WHERE user_id=$1', [id])
  vi.stubEnv('PRODUCT_MODE', 'attendance')
  expect(await authService.verifyToken(result!.token)).toBeNull()
  expect(await authService.refreshToken(result!.token)).toBeNull()
  expect(await currentRoles(id)).toEqual([])
})

it.each(['platform', 'attendance'])('does not grant a role on a rejected password login in %s mode', async mode => {
  vi.stubEnv('PRODUCT_MODE', mode)
  try {
    const id = `timing_${randomUUID()}`
    const email = `${id}@example.test`
    const password = 'Synthetic-Only-9!'
    await query(`INSERT INTO users(id,email,username,name,password_hash,role,is_active,activation_status,
      local_password_set,must_change_password) VALUES ($1,$2,$1,'Synthetic',$3,'user',true,'activated',true,false)`,
    [id, email, await bcrypt.hash(password, 4)])
    const login = (secret: string) => request(server.url()).post('/api/auth/login').send({ identifier: email, password: secret })
    const state = async () => (await query(`SELECT
      (SELECT count(*)::int FROM user_roles WHERE user_id=$1 AND role_id='attendance_employee') AS roles,
      (SELECT count(*)::int FROM user_sessions WHERE user_id=$1) AS sessions`, [id])).rows
    expect((await login('Incorrect-Synthetic-7!')).status).toBe(401)
    expect(await state()).toEqual([{ roles: 0, sessions: 0 }])
    expect((await login(password)).status).toBe(200)
    expect(await state()).toEqual([{ roles: mode === 'attendance' ? 1 : 0, sessions: 1 }])
  } finally {
    vi.unstubAllEnvs()
  }
})

it('keeps signed sessions on the correct side of a forced password change in one JWT second', async () => {
  const id = `revision_${randomUUID()}`
  const email = `${id}@example.test`
  const initial = 'Initial-Synthetic-7!'
  const replacement = 'Replacement-Synthetic-8!'
  await query(`INSERT INTO users(id,email,username,name,password_hash,role,is_active,activation_status,
    local_password_set,must_change_password,access_generation) VALUES ($1,$2,$1,'Synthetic',$3,'user',true,'activated',true,true,1)`,
  [id, email, await bcrypt.hash(initial, 4)])
  const login = (password: string) => request(server.url()).post('/api/auth/login').send({ identifier: email, password })
  const member = (token: string) => request(server.url()).get('/api/synthetic-member').auth(token, { type: 'bearer' })
  const refresh = (token: string) => request(server.url()).post('/api/auth/refresh-token').send({ token })
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date())
  const before = await login(initial)
  expect(before.status).toBe(200)
  const old = before.body.data.token
  const changed = await request(server.url()).post('/api/auth/password/change').auth(old, { type: 'bearer' }).send({ password: replacement })
  expect(changed.status).toBe(200)
  const after = await login(replacement)
  expect(after.status).toBe(200)
  expect((await login(initial)).status).toBe(401)
  expect((await member(old)).status).toBe(401)
  expect(await validateStrictSession(query, old, id)).toBe(false)
  expect((await refresh(old)).status).toBe(401)
  const renewed = await refresh(after.body.data.token)
  expect(renewed.status).toBe(200)
  const orgId = randomUUID()
  await query('INSERT INTO user_orgs(user_id,org_id,is_active) VALUES($1,$2,true)', [id, orgId])
  const switched = await request(server.url()).post('/api/auth/session-org')
    .auth(changed.body.data.token, { type: 'bearer' }).send({ orgId })
  expect(switched.status).toBe(200)
  const receipt = authService.readTokenPayload(changed.body.data.token)
  expect(typeof receipt?.sessionRevision).toBe('string')
  expect(authService.readTokenPayload(switched.body.data.token)).toMatchObject({
    sid: receipt?.sid, sessionRevision: receipt?.sessionRevision, tenantId: orgId,
  })
  const usable = [changed.body.data.token, after.body.data.token, renewed.body.data.token, switched.body.data.token]
  for (const token of usable) {
    expect(authService.readTokenPayload(token)?.iat).toBe(authService.readTokenPayload(old)?.iat)
    expect((await member(token)).status).toBe(204)
    expect(await validateStrictSession(query, token, id)).toBe(true)
  }
  await query('UPDATE user_session_revocations SET revoked_after = revoked_after WHERE user_id = $1', [id])
  for (const token of usable) {
    expect((await member(token)).status).toBe(401)
    expect(await validateStrictSession(query, token, id)).toBe(false)
    expect((await refresh(token)).status).toBe(401)
  }
  const prior = await query('SELECT revoked_after::text AS cutoff FROM user_session_revocations WHERE user_id=$1', [id])
  const lowered = await query(`UPDATE user_session_revocations SET revoked_after=revoked_after-interval '10 minutes'
    WHERE user_id=$1 RETURNING revoked_after::text AS cutoff`, [id])
  expect(lowered.rows).toEqual(prior.rows)
})

it.each(['old password', 'legacy refresh'])('rolls back a pending session registration after revocation: %s', async mode => {
  const id = `race_${randomUUID()}`
  const email = `${id}@example.test`
  const initial = 'Before-Synthetic-1!'
  await query(`INSERT INTO users(id,email,username,name,password_hash,role,is_active,activation_status,
    local_password_set,must_change_password,access_generation) VALUES ($1,$2,$1,'Synthetic',$3,'user',true,'activated',true,false,1)`,
  [id, email, await bcrypt.hash(initial, 4)])
  const legacy = authService.createToken({ id, email, name: 'Synthetic', role: 'user',
    permissions: [], created_at: new Date(), updated_at: new Date() })
  const holder = new Client({ connectionString: process.env.DATABASE_URL })
  await holder.connect()
  let pending: Promise<number> | undefined
  try {
    await holder.query('BEGIN')
    const lock = await holder.query('SELECT pg_backend_pid() AS pid FROM users WHERE id=$1 FOR UPDATE', [id])
    pending = (mode === 'old password'
      ? request(server.url()).post('/api/auth/login').send({ identifier: email, password: initial })
      : request(server.url()).post('/api/auth/refresh-token').send({ token: legacy })).then(response => response.status)
    let waiting = false
    const deadline = Date.now() + 5000
    while (!waiting && Date.now() < deadline) {
      const result = await holder.query(`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
        AND $1=ANY(pg_blocking_pids(pid)) AND query ILIKE '%insert into user_sessions%') AS waiting`, [lock.rows[0].pid])
      waiting = result.rows[0].waiting
      if (!waiting) {
        await holder.query('SELECT pg_stat_clear_snapshot()')
        await delay(10)
      }
    }
    expect(waiting).toBe(true)
    await holder.query('UPDATE users SET password_hash=$2 WHERE id=$1', [id, await bcrypt.hash('After-Synthetic-2!', 4)])
    await holder.query(`INSERT INTO user_session_revocations(user_id,revoked_after,updated_at,updated_by,reason)
      VALUES ($1,clock_timestamp(),clock_timestamp(),$1,'synthetic')`, [id])
    await holder.query('COMMIT')
    expect(await pending).toBe(401)
    expect((await query('SELECT count(*)::int AS count FROM user_sessions WHERE user_id=$1', [id])).rows).toEqual([{ count: 0 }])
  } finally {
    await holder.end()
    await pending
  }
})
