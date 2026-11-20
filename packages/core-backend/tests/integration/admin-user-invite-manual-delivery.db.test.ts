import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import * as bcrypt from 'bcryptjs'
import express from 'express'
import { Client } from 'pg'
import request, { type Response } from 'supertest'
import { beforeAll, expect, it, vi } from 'vitest'
import { authService } from '../../src/auth/AuthService'
import * as oauth from '../../src/auth/dingtalk-oauth'
import { issueInviteToken } from '../../src/auth/invite-tokens'
import { isReadOnlyAuthorizationRequest, jwtAuthMiddleware, readOnlyAuthorizationJwtAuth } from '../../src/auth/jwt-middleware'
import * as activation from '../../src/auth/user-activate'
import { query } from '../../src/db/pg'
import { adminUsersRouter } from '../../src/routes/admin-users'
import { authRouter } from '../../src/routes/auth'
import { usePinnedServer } from '../utils/pinned-server'

const database = 'admin_review_synthetic_delivery'
const password = 'Synthetic-Before-9!'
const replacement = 'Synthetic-After-8!'
const app = express()
const server = usePinnedServer()
server.setApp(app)
app.use(express.json())
app.post('/api/auth/password/change', jwtAuthMiddleware)
app.post('/api/admin/invites/:inviteId/manual-delivery', (req, res, next) =>
  (isReadOnlyAuthorizationRequest(req.method, req.path) ? readOnlyAuthorizationJwtAuth : jwtAuthMiddleware)(req, res, next))
app.use(adminUsersRouter())
app.use('/api/auth', authRouter)
app.get('/api/synthetic-member', jwtAuthMiddleware, (_req, res) => res.sendStatus(204))
let actor: string
let member: string
const credentials = new Map<string, string>()
let originalHash: string

async function user(admin = false) {
  const id = `delivery_${randomUUID()}`
  const role = admin ? 'admin' : 'user'
  await query(`INSERT INTO users(id, email, username, name, password_hash, role, is_admin,
    is_active, activation_status, local_password_set, must_change_password, access_generation)
    VALUES ($1,$2,$1,'Synthetic',$3,$4,$5,true,'activated',true,false,7)`,
  [id, `${id}@example.test`, originalHash, role, admin])
  await query("INSERT INTO user_roles(user_id,role_id,assignment_source) VALUES ($1,$2,'manual')", [id, role])
  return id
}

beforeAll(async () => {
  const url = new URL(process.env.DATABASE_URL || 'invalid:')
  if (url.pathname !== '/' + database || url.searchParams.has('dbname') || url.searchParams.has('database')
    || !['localhost', '127.0.0.1'].includes(url.hostname)
    || [...url.searchParams.keys()].some(key => key !== 'host')
    || (url.searchParams.has('host') && !url.searchParams.get('host')?.startsWith('/tmp/manual-delivery.'))) {
    throw new Error('Dedicated local delivery database required')
  }
  expect((await query('SELECT current_database() AS name')).rows).toEqual([{ name: database }])
  expect([process.env.EXPECT_DB, process.env.RBAC_BYPASS, process.env.RBAC_TOKEN_TRUST]).toEqual(['1','false','false'])
  originalHash = await bcrypt.hash(password, 4)
  await query("INSERT INTO roles(id,name) VALUES ('admin','Synthetic admin'),('user','Synthetic user') ON CONFLICT DO NOTHING")
  actor = await user(true)
  member = await user()
  await signIn(actor)
  await signIn(member)
})

async function invite(id = '') {
  const userId = id || await user()
  const email = `${userId}@example.test`
  const token = issueInviteToken({ userId, email })
  const row = await query(`INSERT INTO user_invites(user_id,email,invite_token,product_mode,invited_by)
    VALUES ($1,$2,$3,'platform',$4) RETURNING id`, [userId,email,token,actor])
  return { userId, email, token, inviteId: String(row.rows[0].id) }
}

type Fixture = Awaited<ReturnType<typeof invite>>
async function signIn(id: string) {
  const result = await request(server.url()).post('/api/auth/login').send({ identifier: `${id}@example.test`, password })
  expect(result.status).toBe(200)
  const token = result.body.data.token
  const sid = authService.readTokenPayload(token)?.sid
  expect(typeof sid).toBe('string')
  expect((await query('SELECT 1 FROM user_sessions WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL', [sid, id])).rowCount).toBe(1)
  credentials.set(id, token)
}
function bearer(id: string) {
  const token = credentials.get(id)
  if (!token) throw new Error('Expected a registered password-login session')
  return token
}
function adminPost(target: Fixture, operation: string, id = actor, body = {}) {
  return request(server.url()).post(`/api/admin/invites/${target.inviteId}/${operation}`).auth(bearer(id), { type: 'bearer' }).send(body)
}
function login(target: Fixture, secret = password) {
  return request(server.url()).post('/api/auth/login').send({ identifier: target.email, password: secret })
}
function accept(target: Fixture) {
  return request(server.url()).post('/api/auth/invite/accept').send({ token: target.token, password: replacement })
}
function deliver(target: Fixture) {
  return adminPost(target, 'manual-delivery')
}
async function state(target: Fixture) {
  return (await query(`SELECT status, access_generation::int AS gen, must_change_password AS forced,
    accepted_at IS NOT NULL AS accepted, consumed_by IS NOT NULL AS consumed,
    (SELECT count(*)::int FROM user_sessions WHERE user_id=u.id) AS sessions,
    (SELECT count(*)::int FROM audit_logs WHERE action='manual_delivery' AND resource_id=i.id::text) AS audits
    FROM users u JOIN user_invites i ON i.user_id=u.id WHERE i.id=$1`, [target.inviteId])).rows[0]
}
async function snapshot(target: Fixture) {
  return (await query(`SELECT md5(to_jsonb(u)::text) AS account, md5(to_jsonb(i)::text) AS invite
    FROM users u JOIN user_invites i ON i.user_id=u.id WHERE i.id=$1`, [target.inviteId])).rows
}
async function directory(userId: string) {
  const corp = randomUUID()
  const account = randomUUID()
  await query(`INSERT INTO directory_integrations(id,org_id,provider,name,corp_id,sync_enabled,status)
    VALUES ($1,'default','dingtalk',$2,$2,false,'active')`, [corp,corp])
  await query(`INSERT INTO directory_accounts(id,integration_id,provider,corp_id,external_user_id,external_key,name,open_id,union_id)
    VALUES ($1,$2,'dingtalk',$3,$4,$4,'Synthetic',$4,$4)`, [account,corp,corp,account])
  await query("INSERT INTO directory_account_links(directory_account_id,local_user_id,link_status) VALUES ($1,$2,'linked')", [account,userId])
  return { corp, account }
}
async function authority(userId: string) {
  const rows = []
  for (const [table, key] of [['user_roles','user_id'], ['user_orgs','user_id'], ['user_namespace_admissions','user_id'],
    ['directory_account_links','local_user_id'], ['directory_deprovision_events','local_user_id'], ['user_external_auth_grants','local_user_id']]) {
    const result = await query(`SELECT md5(to_jsonb(record)::text) AS fingerprint FROM ${table} record WHERE ${key}=$1 ORDER BY 1`, [userId])
    expect(result.rowCount).toBe(1)
    rows.push(result.rows)
  }
  return rows
}
function refused(response: Response, status: number) {
  expect(response.status).toBe(status)
  expect(Object.hasOwn(response.body, 'data')).toBe(false)
  expect(JSON.stringify(response.body).includes('temporaryPassword')).toBe(false)
}

it('preserves the original principal and grants, retires both old credentials and completes first password change', async () => {
  const target = await invite()
  const { corp, account } = await directory(target.userId)
  await query("INSERT INTO user_orgs(user_id,org_id,is_active) VALUES ($1,'default',true)", [target.userId])
  await query("INSERT INTO user_namespace_admissions(user_id,namespace,enabled,source) VALUES ($1,'attendance',false,'role_unassigned')", [target.userId])
  await query("INSERT INTO user_external_auth_grants(local_user_id,provider,enabled) VALUES ($1,'dingtalk',false)", [target.userId])
  await query(`INSERT INTO directory_deprovision_events(id,org_id,integration_id,directory_account_id,local_user_id,
    triggered_by,event_origin,link_witness_account_id,link_witness_local_user_id,policy,globally_clear,access_generation_at_apply,status)
    VALUES ($1,'default',$2,$3,$4,$5,'admin_manual',$3,$4,'mark_inactive',true,7,'superseded')`,
  [randomUUID(),corp,account,target.userId,actor])
  const before = await authority(target.userId)
  const delivered = await deliver(target)
  expect(delivered.status).toBe(200)
  expect(delivered.headers['cache-control']).toBe('no-store')
  expect(Object.keys(delivered.body.data).sort()).toEqual(['loginIdentifier','temporaryPassword'])
  expect(delivered.body.data.loginIdentifier === target.email).toBe(true)
  const temporary = delivered.body.data.temporaryPassword
  expect(typeof temporary === 'string' && temporary.length > 0 && temporary !== password).toBe(true)
  expect(await authority(target.userId)).toEqual(before)
  expect(await state(target)).toEqual({ status:'manual_delivery', gen:8, forced:true, accepted:false, consumed:false, sessions:0, audits:1 })
  const audit = await query(`SELECT action_details=jsonb_build_object('adminUserId',$2::text) AS attributed,
    created_at IS NOT NULL AS dated, strpos(to_jsonb(a)::text,$3)=0 AS safe FROM audit_logs a
    WHERE resource_id=$1 AND action='manual_delivery'`, [target.inviteId,actor,temporary])
  expect(audit.rows).toEqual([{ attributed:true, dated:true, safe:true }])
  const listing = await request(server.url()).get('/api/admin/invites').auth(bearer(actor), { type:'bearer' }).query({userId:target.userId})
  expect(listing.status).toBe(200)
  expect(listing.body.data.items.map((item: { status:string }) => item.status)).toEqual(['manual_delivery'])
  expect(listing.text.includes(temporary) || listing.text.includes('temporaryPassword')).toBe(false)
  refused(await adminPost(target, 'resend'), 409)
  refused(await accept(target), 409)
  refused(await request(server.url()).get('/api/auth/invite/preview').query({ token:target.token }), 409)
  refused(await login(target), 401)
  const first = await login(target, temporary)
  expect(first.status).toBe(200)
  expect(first.body.data.user.id === target.userId && first.body.data.passwordChangeRequired === true).toBe(true)
  const memberPage = (token:string) => request(server.url()).get('/api/synthetic-member').auth(token,{type:'bearer'})
  const denied = await memberPage(first.body.data.token)
  expect(denied.status).toBe(403)
  expect(denied.body.error.code).toBe('PASSWORD_CHANGE_REQUIRED')
  const changed = await request(server.url()).post('/api/auth/password/change').auth(first.body.data.token, { type:'bearer' }).send({ password:replacement })
  expect(changed.status).toBe(200)
  refused(await login(target, temporary), 401)
  const next = await login(target, replacement)
  expect(next.status).toBe(200)
  expect(next.body.data.passwordChangeRequired).toBe(false)
  expect((await memberPage(next.body.data.token)).status).toBe(204)
})

it.each(['non-admin','self','override','inactive','pending activation','no local password','deleted','purged',
  'last login','revoked session','accepted','revoked','second invite','invalid signature','expired signature',
  'different subject','different email','stale version','ambiguous identifier','alias unready'] as const)(
  'rejects %s without writes or credentials', async reason => {
    const target = await invite(reason === 'self' ? actor : '')
    const updates: Record<string,string> = { inactive:'is_active=false', 'pending activation':"activation_status='pending_activation'",
      'no local password':'local_password_set=false', deleted:'deleted_at=now()', purged:'purged_at=now()',
      'last login':'last_login_at=now()', 'stale version':"updated_at=now()+interval '5 seconds'" }
    if (updates[reason]) await query(`UPDATE users SET ${updates[reason]} WHERE id=$1`, [target.userId])
    if (reason === 'revoked session') await query(`INSERT INTO user_sessions(id,user_id,issued_at,expires_at,last_seen_at,revoked_at)
      VALUES ($1,$2,now(),now(),now(),now())`, [randomUUID(),target.userId])
    if (reason === 'second invite') await invite(target.userId)
    if (reason === 'accepted' || reason === 'revoked') await query('UPDATE user_invites SET status=$2 WHERE id=$1',[target.inviteId,reason])
    if (['invalid signature','expired signature','different subject','different email'].includes(reason)) {
      const token = reason === 'invalid signature' ? 'invalid' : issueInviteToken({
        userId:reason === 'different subject' ? actor : target.userId,
        email:reason === 'different email' ? 'other@example.test' : target.email,
        expiresIn:reason === 'expired signature' ? -10 : '1h',
      })
      await query('UPDATE user_invites SET invite_token=$2 WHERE id=$1',[target.inviteId,token])
    }
    if (reason === 'ambiguous identifier') await query('UPDATE users SET username=$1 WHERE id=$2',[target.email,await user()])
    const before = await snapshot(target)
    if (reason === 'alias unready') {
      await query("INSERT INTO user_login_aliases(user_id,kind,normalized_value,source) VALUES ($1,'email',$2,'test_seed')",[target.userId,target.email])
      vi.stubEnv('AUTH_LOGIN_USE_ALIASES','true')
    }
    try {
      refused(await adminPost(target,'manual-delivery',reason === 'non-admin' ? member : actor,
        reason === 'override' ? { password:replacement } : {}), reason === 'non-admin' ? 403 : reason === 'override' ? 400 : 409)
      expect(await snapshot(target)).toEqual(before)
      expect((await state(target)).audits).toBe(0)
    } finally {
      vi.unstubAllEnvs()
    }
  })

it.each(['pending', 'expired', 'revoked'])('preserves ordinary resend for %s invitations', async status => {
  const target = await invite()
  await query('UPDATE user_invites SET status=$2 WHERE id=$1', [target.inviteId, status])
  expect((await adminPost(target, 'resend')).status).toBe(200)
  const ledger = await query(`SELECT status, invite_token <> $2 AS rotated
    FROM user_invites WHERE id=$1`, [target.inviteId, target.token])
  expect(ledger.rows).toEqual([{ status: 'pending', rotated: true }])
})

it('uses the exact email alias owner after readiness is established and never repairs a wrong binding', async () => {
  const target = await invite()
  const other = await user()
  await query(`INSERT INTO user_login_aliases(user_id,kind,normalized_value,source)
    VALUES ($1,'email',$2,'test_seed'), ($3,'email',$4,'test_seed')`, [actor, `${actor}@example.test`, other, target.email])
  vi.stubEnv('AUTH_LOGIN_USE_ALIASES', 'true')
  try {
    const before = await snapshot(target)
    refused(await deliver(target), 409)
    expect(await snapshot(target)).toEqual(before)
    expect((await query('UPDATE user_login_aliases SET user_id=$1 WHERE normalized_value=$2 AND user_id=$3',
      [target.userId, target.email, other])).rowCount).toBe(1)
    const delivered = await deliver(target)
    expect(delivered.status).toBe(200)
    const loggedIn = await login(target, delivered.body.data.temporaryPassword)
    expect(loggedIn.status).toBe(200)
    expect(loggedIn.body.data.user.id === target.userId).toBe(true)
  } finally {
    vi.unstubAllEnvs()
    await query('DELETE FROM user_login_aliases WHERE user_id=$1', [actor])
  }
})

async function waiter(holder: number, excluded: number[], statement: string) {
  const deadline = Date.now() + 6000
  while (Date.now() < deadline) {
    const result = await query(`WITH RECURSIVE blocked(pid) AS (
      SELECT $1::int UNION SELECT activity.pid FROM pg_stat_activity activity JOIN blocked
      ON blocked.pid=ANY(pg_blocking_pids(activity.pid)) WHERE datname=current_database() AND wait_event_type='Lock'
    ) SELECT pid FROM pg_stat_activity WHERE pid IN (SELECT pid FROM blocked) AND pid<>$1
      AND NOT(pid=ANY($2::int[])) AND query ILIKE $3`, [holder,excluded,`%${statement}%`])
    if (result.rowCount === 1) return Number(result.rows[0].pid)
    await delay(20)
  }
  throw new Error('Expected distinct route statement in holder lock chain')
}

type Operation = 'deliver' | 'accept' | 'login' | 'resend'
async function actorRoles(id: string) {
  return (await query('SELECT role_id, assignment_source, created_at FROM user_roles WHERE user_id=$1 ORDER BY role_id', [id])).rows
}

it('does not bootstrap or otherwise change a refused session holder’s persisted attendance roles', async () => {
  const target = await invite()
  const before = await snapshot(target)
  const roles = await actorRoles(member)
  expect(roles.map(row => row.role_id)).toEqual(['user'])
  vi.stubEnv('PRODUCT_MODE', 'attendance')
  try {
    refused(await adminPost(target, 'manual-delivery', member), 403)
    expect(await actorRoles(member)).toEqual(roles)
    expect(await snapshot(target)).toEqual(before)
    expect((await state(target)).audits).toBe(0)
  } finally {
    vi.unstubAllEnvs()
  }
})

it('rechecks an authenticated administrator after real batch demotion commits during the target row wait', async () => {
  const target = await invite()
  const admin = await user(true)
  await signIn(admin)
  const before = await snapshot(target)
  const held = new Client({ connectionString: process.env.DATABASE_URL })
  await held.connect()
  let pending: Promise<Response> | undefined
  let demotedRoles: Awaited<ReturnType<typeof actorRoles>> = []
  try {
    await held.query('BEGIN')
    const lock = await held.query('SELECT pg_backend_pid() AS pid FROM users WHERE id=$1 FOR UPDATE', [target.userId])
    pending = adminPost(target, 'manual-delivery', admin).then(response => response)
    await waiter(lock.rows[0].pid, [], 'for update')
    const changed = await request(server.url()).post('/api/admin/users/batch/update').auth(bearer(actor), { type: 'bearer' })
      .send({ items: [{userId:admin, roleId:'user'}] })
    expect(changed.status).toBe(200)
    expect(changed.body.data.successCount).toBe(1)
    demotedRoles = await actorRoles(admin)
    expect(demotedRoles.map(row => row.role_id)).toEqual(['user'])
  } finally {
    await held.end()
    await Promise.allSettled([pending])
  }
  if (!pending) throw new Error('Missing delivery request')
  refused(await pending, 403)
  expect(await actorRoles(admin)).toEqual(demotedRoles)
  expect(await snapshot(target)).toEqual(before)
  expect((await state(target)).audits).toBe(0)
})

it.each(['revocation first', 'delivery first'])('holds durable admin membership through the transaction: %s', async order => {
  const target = await invite()
  const admin = await user(true)
  await signIn(admin)
  await query("INSERT INTO user_roles(user_id,role_id,assignment_source) VALUES ($1,'user','manual')", [admin])
  const beforeRoles = await actorRoles(admin)
  const before = await snapshot(target)
  const held = new Client({ connectionString: process.env.DATABASE_URL })
  await held.connect()
  const revoke = "DELETE FROM user_roles WHERE user_id=$1 AND role_id='admin'"
  let delivery: Promise<Response> | undefined
  let revocation: Promise<number | null> | undefined
  try {
    await held.query('BEGIN')
    const pid = (await held.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
    if (order === 'revocation first') {
      expect((await held.query(revoke, [admin])).rowCount).toBe(1)
    } else {
      await held.query('LOCK TABLE audit_logs IN SHARE MODE')
    }
    delivery = adminPost(target, 'manual-delivery', admin).then(response => response)
    const waiterPid = await waiter(pid, [], order === 'revocation first' ? 'for share' : 'insert into audit_logs')
    if (order === 'delivery first') {
      revocation = query(revoke, [admin]).then(result => result.rowCount)
      await waiter(waiterPid, [], 'delete from user_roles')
    }
    await held.query('COMMIT')
  } finally {
    await held.end()
    await Promise.allSettled([delivery, revocation])
  }
  if (!delivery) throw new Error('Missing delivery request')
  const response = await delivery
  if (order === 'revocation first') {
    refused(response, 403)
    expect(await snapshot(target)).toEqual(before)
    expect((await state(target)).audits).toBe(0)
  } else {
    expect(response.status).toBe(200)
    expect(await revocation).toBe(1)
    expect((await state(target)).audits).toBe(1)
  }
  expect(await actorRoles(admin)).toEqual(beforeRoles.filter(row => row.role_id !== 'admin'))
})

const operations = { deliver, accept, login, resend:(target: Fixture) => adminPost(target,'resend') }
const cases: [Operation,Operation,number,number][] = [
  ['deliver','deliver',200,409], ['accept','deliver',200,409], ['deliver','accept',200,409],
  ['login','deliver',200,409], ['deliver','login',200,401], ['resend','deliver',200,200], ['deliver','resend',200,409],
]
it.each(cases)('queues %s before %s on distinct PostgreSQL backends', async (first,second,firstStatus,secondStatus) => {
  const target = await invite()
  const onInvite = first === 'resend' || second === 'resend'
  if (first === 'resend') await query("UPDATE user_invites SET invite_token='invalid-before-resend' WHERE id=$1", [target.inviteId])
  const statements = { deliver:onInvite ? 'from user_invites where user_id' : 'from users where id',
    accept:'for update', login:'insert into user_sessions', resend:'update user_invites' }
  const holder = new Client({ connectionString: process.env.DATABASE_URL })
  await holder.connect()
  const pending: Promise<Response>[] = []
  try {
    await holder.query('BEGIN')
    const held = await holder.query(onInvite ? 'SELECT pg_backend_pid() AS pid FROM user_invites WHERE id=$1 FOR UPDATE'
      : 'SELECT pg_backend_pid() AS pid FROM users WHERE id=$1 FOR UPDATE',[onInvite ? target.inviteId : target.userId])
    const pid = held.rows[0].pid
    pending.push(operations[first](target).then(response => response))
    const firstPid = await waiter(pid,[],statements[first])
    pending.push(operations[second](target).then(response => response))
    await waiter(pid,[firstPid],statements[second])
  } finally {
    await holder.end()
    await Promise.allSettled(pending)
  }
  const [winner, follower] = await Promise.all(pending)
  expect(winner.status).toBe(firstStatus)
  if (secondStatus !== 200) refused(follower,secondStatus)
  else expect(follower.status).toBe(200)
  const delivered = first === 'deliver' || secondStatus === 200
  expect(await state(target)).toEqual({
    status: delivered ? 'manual_delivery' : first === 'accept' ? 'accepted' : 'pending',
    gen:delivered ? 8 : 7, forced:delivered, accepted:first === 'accept', consumed:first === 'accept',
    sessions:delivered ? 0 : 1, audits:delivered ? 1 : 0,
  })
})

it.each(['user_invites','users','audit_logs'] as const)('rolls back both credentials and ledger if writing %s fails', async table => {
  const target = await invite()
  const before = await snapshot(target)
  const constraint = 'delivery_fault_' + randomUUID().replaceAll('-','')
  const predicate = {
    audit_logs:`action <> 'manual_delivery' OR resource_id <> '${target.inviteId}'`,
    users:`access_generation = 7 OR id <> '${target.userId}'`,
    user_invites:`status <> 'manual_delivery' OR id <> '${target.inviteId}'`,
  }[table]
  await query(`ALTER TABLE ${table} ADD CONSTRAINT ${constraint} CHECK (${predicate})`)
  try {
    refused(await deliver(target),500)
    expect(await snapshot(target)).toEqual(before)
    expect((await state(target)).audits).toBe(0)
  } finally {
    await query(`ALTER TABLE ${table} DROP CONSTRAINT ${constraint}`)
  }
})

it('refuses the real SSO callback registration after activation commits and delivery advances its generation', async () => {
  const userId = await user()
  const { corp, account } = await directory(userId)
  await query("UPDATE users SET activation_status='pending_activation', local_password_set=false WHERE id=$1",[userId])
  vi.spyOn(oauth,'validateState').mockResolvedValue({ valid:true,intent:'activate',activateUserId:userId,activateAdminUserId:actor })
  vi.spyOn(oauth,'isDingTalkConfigured').mockReturnValue(true)
  vi.spyOn(oauth,'exchangeCodeForDingTalkProfile').mockResolvedValue({ openId:account,unionId:account,nick:'Synthetic' })
  vi.spyOn(oauth,'getDingTalkRuntimeStatus').mockReturnValue({ ...oauth.getDingTalkRuntimeStatus(),corpId:corp })
  const activate = activation.activatePendingUser
  let committed = false
  vi.spyOn(activation,'activatePendingUser').mockImplementation(async (input, forSession) => {
    const generation = await activate(input,forSession)
    await query('UPDATE users SET password_hash=$2,local_password_set=true,updated_at=now() WHERE id=$1',[userId,originalHash])
    const target = await invite(userId)
    expect((await deliver(target)).status).toBe(200)
    committed = true
    return generation
  })
  try {
    const callback = await request(server.url()).post('/api/auth/dingtalk/callback').send({ code:'synthetic',state:'synthetic' })
    expect(committed).toBe(true)
    refused(callback,409)
    expect(callback.body.code).toBe('authentication_changed')
    expect((await query('SELECT count(*)::int AS count FROM user_sessions WHERE user_id=$1',[userId])).rows).toEqual([{ count:0 }])
  } finally {
    vi.restoreAllMocks()
  }
})
