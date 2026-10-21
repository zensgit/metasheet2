/** Actual PostgreSQL authority locks, production Redis and real Native API.
 * Meta session rows are provisioned against live Native delegations; mounted JWT/router and independent workers run, not the full app or browser callback.
 */
import { beforeAll, afterAll, it, expect } from 'vitest'
import { randomUUID, randomBytes, createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { fork, spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { resolve } from 'node:path'
import { createServer, type Server } from 'node:http'
import express, { type Request } from 'express'
import { Pool } from 'pg'
import { Kysely, PostgresDialect } from 'kysely'
import { bootstrapPlmBomReviewTestDb } from '../plm-bom-review/bootstrap'
import { up as managedUp } from '../../src/db/migrations/zzzz20261018010000_create_plm_managed_companion'
import { up as snapshotUp } from '../../src/db/migrations/zzzz20261019010000_create_plm_snapshot_share_intents'
import { up as readUp } from '../../src/db/migrations/zzzz20261020010000_add_plm_listener_personal_reads'
import { up as unlinkUp } from '../../src/db/migrations/zzzz20261020020000_stop_personal_reads_on_unlink'
import { sourceFingerprint } from '../../src/services/plm-managed-companion'
import { managedRequestContext } from '../../src/services/plm-managed-request-context'
import { relayManagedDiscussion } from '../../src/services/plm-managed-discussion'
import { closeRedisClient } from '../../src/db/redis'
import { poolManager } from '../../src/integration/db/connection-pool'
import { jwtAuthMiddleware, isWhitelisted } from '../../src/auth/jwt-middleware'
import managedRouter from '../../src/routes/plm-managed-companion'
import { signManagedSessionToken } from '../../src/auth/plm-managed-session'
import { sealCredential } from '../../src/services/plm-managed-companion'
const url = process.env.PLM_MANAGED_DISCUSSION_TEST_PG_URL
if (!url || url !== process.env.DATABASE_URL || !new URL(url).searchParams.get('host')?.startsWith('/tmp/plm-mdpg-s-')) {
  throw new Error('Explicit owned PostgreSQL URL required; no skip-green')
}
const native = process.env.PLM_MANAGED_DISCUSSION_NATIVE_URL!
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(native)) throw new Error('Owned Native child required')
const pool = new Pool({ connectionString: url, max: 8 })
const db = new Kysely({ dialect: new PostgresDialect({ pool }) })
let server: Server, metaServer: Server, metaUrl: string, proxy: string, installationIssuer: string, bearer: string, uiCookie: string
let entered: (() => void) | undefined, release: Promise<void> | undefined
let exchangeCalls = 0
const nativePreviewStatuses: number[] = []
const workers: { child: ChildProcess; url: string; exit: Promise<number | null>; stopped: () => boolean }[] = []
const workerStops: { pid: number | undefined; exit: number | null; stopped: boolean }[] = []
async function startWorker() {
  const child = fork(resolve('tests/integration/fixtures/plm-managed-discussion-worker.cjs'), [], {
    execArgv: ['--require', resolve('../../node_modules/tsx/dist/cjs/index.cjs')],
    env: process.env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  // Keep private worker logs in the owned test report only on failure; never forward credentials.
  let log = '', stopped = false
  child.stdout?.on('data', data => { log = (log + data).slice(-4000) })
  child.stderr?.on('data', data => { log = (log + data).slice(-4000) })
  const exit = new Promise<number | null>(resolve => child.once('exit', resolve))
  const ready = new Promise<string>((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error('Owned worker startup deadline')), 15000)
    child.on('message', (message: any) => {
      if (message?.type === 'stopped' && message.pid === child.pid) stopped = true
      if (message?.type === 'ready' && message.pid === child.pid && Number.isInteger(message.port) && message.port > 0) {
        clearTimeout(deadline); resolve('http://127.0.0.1:' + message.port)
      }
    })
    child.once('exit', () => { clearTimeout(deadline); reject(new Error('Owned worker exited before ready: ' + log)) })
  })
  const worker = { child, url: '', exit, stopped: () => stopped }
  workers.push(worker)
  worker.url = await ready
}
beforeAll(async () => {
  server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    if (req.url?.includes('/auth/embed/')) {
      exchangeCalls++
      entered?.(); await release
    }
    try {
      const response = await fetch(native + req.url, { method: req.method, redirect: 'error',
        headers: { 'Content-Type': 'application/json', ...(req.headers.authorization ? { Authorization: req.headers.authorization } : {}),
          ...(typeof req.headers['x-tenant-id'] === 'string' ? { 'x-tenant-id': req.headers['x-tenant-id'] } : {}),
          ...(typeof req.headers['x-org-id'] === 'string' ? { 'x-org-id': req.headers['x-org-id'] } : {}) },
        ...(['GET', 'HEAD'].includes(req.method!) ? {} : { body }), signal: AbortSignal.timeout(10000) })
      if (req.url === '/api/v1/auth/embed/visual-preview-session') nativePreviewStatuses.push(response.status)
      res.statusCode = response.status; res.setHeader('Content-Type', response.headers.get('content-type') ?? 'application/json')
      res.end(Buffer.from(await response.arrayBuffer()))
    } catch { res.statusCode = 502; res.end('{}') }
  })
  await new Promise<void>(resolve => server.listen(Number(process.env.PLM_MANAGED_DISCUSSION_PROXY_PORT ?? 0), '127.0.0.1', resolve))
  proxy = 'http://127.0.0.1:' + (server.address() as { port: number }).port
  process.env.PLM_MANAGED_COMPANION_ENABLED = 'true'
  installationIssuer = proxy + '/installation'
  process.env.PLM_MANAGED_COMPANION_CLIENTS_JSON = JSON.stringify([{ issuer: installationIssuer,
    clientId: 'discussion-client', clientSecret: 'owned-client-secret', callback: 'https://meta.example.test/api/plm/managed-login/callback',
    origin: 'https://meta.example.test', nativeTenantId: 'default', nativeOrgId: 'fixture-org', nativeBaseUrl: proxy }])
  await bootstrapPlmBomReviewTestDb(pool)
  await pool.query('CREATE TABLE user_orgs(user_id text,org_id text,is_active boolean);ALTER TABLE users ADD COLUMN must_change_password boolean DEFAULT false')
  await managedUp(db); await snapshotUp(db); await readUp(db); await unlinkUp(db)
  await pool.query('ALTER TABLE users ADD COLUMN email text,ADD COLUMN name text,ADD COLUMN created_at timestamptz DEFAULT now(),ADD COLUMN updated_at timestamptz DEFAULT now()')
  await pool.query("INSERT INTO users(id,is_active,role,activation_status,local_password_set,permissions)VALUES('other',true,'user','activated',true,'{}');INSERT INTO user_orgs VALUES('other','meta-tenant',true),('other','meta-org',true)")
  const login = await fetch(native + '/api/v1/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', origin: native, 'x-yuantus-ui-request': 'login' },
    body: JSON.stringify({ username: 'discussion-writer', password: 'synthetic-discussion-only', tenant_id: 'default', org_id: 'fixture-org' }) })
  expect(login.status).toBe(200); bearer = (await login.json() as { access_token: string }).access_token
  uiCookie = login.headers.get('set-cookie')!.split(';')[0]
  const app = express(); app.use(express.json())
  app.use((req, res, next) => isWhitelisted(req.path) ? next() : jwtAuthMiddleware(req, res, next))
  app.use('/api/plm/managed-login', managedRouter)
  metaServer = app.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => metaServer.once('listening', resolve))
  metaUrl = 'http://127.0.0.1:' + (metaServer.address() as { port: number }).port
  await startWorker(); await startWorker()
  expect(workers[0].child.pid).not.toBe(workers[1].child.pid)
})
afterAll(async () => {
  entered = undefined; release = undefined
  for (const worker of workers) {
    worker.child.kill('SIGTERM')
    const code = await Promise.race([worker.exit, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Owned worker shutdown deadline')), 10000))])
    workerStops.push({ pid: worker.child.pid, exit: code, stopped: worker.stopped() })
    expect(code).toBe(0); expect(worker.stopped()).toBe(true)
  }
  metaServer.closeAllConnections(); await new Promise<void>(resolve => metaServer.close(() => resolve()))
  server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
  await closeRedisClient(); await poolManager.close(); await pool.end()
  if (process.env.PLM_MANAGED_DISCUSSION_WORKER_PROOF) writeFileSync(process.env.PLM_MANAGED_DISCUSSION_WORKER_PROOF, JSON.stringify({ workers: workerStops }))
})
async function fixture(seconds = 300, issued?: { delegation_id: string; credential: string }) {
  const actor = 'meta-owner-' + randomUUID(), source = randomUUID(), link = randomUUID(), session = randomUUID(), intent = randomUUID()
  const delegation = issued?.delegation_id ?? 'delegation-' + session
  const ciphertext = issued ? sealCredential(issued.credential) : 'enc:read-fixture'
  const config = { connection: { url: proxy }, options: { apiMode: 'yuantus', tenantId: 'default', orgId: 'fixture-org' } }
  await pool.query("INSERT INTO users(id,is_active,role,activation_status,local_password_set,permissions)VALUES($1,true,'user','activated',true,'{}')", [actor])
  await pool.query("INSERT INTO user_orgs VALUES($1,'meta-tenant',true),($1,'meta-org',true)", [actor])
  await pool.query("INSERT INTO data_sources(id,name,type,config,owner_id,is_active,tenant_id,workspace_id,scope_kind)VALUES($1,'Discussion','plm',$2::jsonb,$3,true,'meta-tenant','meta-org','user')", [source, JSON.stringify(config), actor])
  const fp = sourceFingerprint({ type: 'plm', origin: proxy, ownerId: actor, rootPartId: 'part', tenantId: 'meta-tenant', workspaceId: 'meta-org', scopeKind: 'user' })
  await pool.query(`INSERT INTO plm_managed_identity_links(id,installation_issuer,native_auth_user_id,native_tenant_id,native_org_id,client_id,callback,meta_user_id,meta_tenant_id,meta_org_id,data_source_id,root_part_id,client_origin,generation,status,owner_user_id,created_by,source_fingerprint)
    VALUES($1,$2,'42','default','fixture-org','discussion-client',$3,$4,'meta-tenant','meta-org',$5,'part','https://meta.example.test',1,'active',$4,$4,$6)`,
    [link, installationIssuer, 'https://meta.example.test/api/plm/managed-login/callback', actor, source, fp])
  await pool.query(`INSERT INTO plm_managed_browser_intents(id,link_id,generation,meta_user_id,meta_tenant_id,meta_org_id,data_source_id,root_part_id,client_origin,installation_issuer,native_tenant_id,native_org_id,callback,client_id,state_hash,nonce_hash,code_challenge,code_verifier_ciphertext,return_path,status,expires_at,consumed_at,delegation_id,credential_ciphertext)
    VALUES($1,$2,1,$3,'meta-tenant','meta-org',$4,'part','https://meta.example.test',$5,'default','fixture-org',$6,'discussion-client',$7,$7,$8,'enc:fixture','/plm/bom-review','consumed',now()+interval '5 minutes',now(),$9,'enc:read-fixture')`,
    [intent, link, actor, source, installationIssuer, 'https://meta.example.test/api/plm/managed-login/callback', 'a'.repeat(64), 'a'.repeat(43), delegation])
  await pool.query("INSERT INTO plm_managed_source_bindings(data_source_id,link_id,generation,source_fingerprint,status,frozen_origin,frozen_root_part_id)VALUES($1,$2,1,$3,'active',$4,'part')", [source, link, fp, proxy])
  await pool.query(`INSERT INTO plm_managed_sessions(id,intent_id,link_id,data_source_id,generation,delegation_id,credential_ciphertext,expires_at,scope,native_subject,native_tenant_id,native_org_id,meta_user_id,meta_tenant_id,meta_org_id,root_part_id,client_origin,installation_issuer,client_id)
    VALUES($1,$2,$3,$4,1,$5,$9,now()+make_interval(secs=>$8),'bom_review_read','42','default','fixture-org',$6,'meta-tenant','meta-org','part','https://meta.example.test',$7,'discussion-client')`,
    [session, intent, link, source, delegation, actor, installationIssuer, seconds, ciphertext])
  async function req(body: unknown = { operation: 'create', body: { target_type: 'item', target_id: 'part', body: 'Managed real Native comment' } }) {
    const response = await firstPartyMint()
    expect(response.status).toBe(200)
    return { user: { id: actor }, authenticatedTenantId: 'meta-tenant', body,
      headers: { origin: 'https://meta.example.test', 'content-type': 'application/json',
        'x-plm-embed-token': (await response.json() as { embed_token: string }).embed_token } } as Request
  }
  const run = (request: Request) => managedRequestContext.run({ userId: actor, sessionId: session, conflict: false }, () => relayManagedDiscussion(request, source))
  const expiresAt = (await pool.query('SELECT expires_at FROM plm_managed_sessions WHERE id=$1', [session])).rows[0].expires_at
  return { actor, source, link, session, req, run, expiresAt, delegation }
}
async function waitFor(check: () => Promise<boolean>) {
  const deadline = Date.now() + 5000
  while (!await check()) { if (Date.now() > deadline) throw new Error('Owned PG wait deadline'); await new Promise(resolve => setTimeout(resolve, 20)) }
}
function firstPartyMint(cookie = uiCookie, authorization?: string) {
  return fetch(native + '/api/v1/auth/managed-login/discussion-token', { method: 'POST',
    headers: { 'Content-Type': 'application/json', origin: native, 'x-yuantus-ui-request': 'managed-login',
      ...(cookie ? { Cookie: cookie } : {}), ...(authorization ? { Authorization: authorization } : {}) },
    body: JSON.stringify({ root_part_id: 'part', client_id: 'discussion-client' }) })
}
it('requires the current UI cookie and refuses a normal bearer even with that cookie before minting', async () => {
  expect((await firstPartyMint('')).status).toBe(401)
  expect((await firstPartyMint('', 'Bearer ' + bearer)).status).toBe(401)
  expect((await firstPartyMint(uiCookie, 'Bearer ' + bearer)).status).toBe(401)
  const accepted = await firstPartyMint()
  expect(accepted.status).toBe(200)
  expect(Object.keys(await accepted.json() as object).sort()).toEqual(['embed_origin', 'embed_token', 'expires_in', 'navigation_url'])
  expect(accepted.headers.get('cache-control')).toBe('no-store')
})
it('mints independent cookie-bound tokens concurrently and admits each only once across Meta processes', async () => {
  const f = await delegatedFixture()
  const requests = await Promise.all([f.req(), f.req()])
  expect(requests[0].headers['x-plm-embed-token']).not.toBe(requests[1].headers['x-plm-embed-token'])
  const created = await Promise.all(requests.map((request, index) => httpManaged(f, request, f.cookie, workers[index].url)))
  expect(created.map(value => value.status)).toEqual([200, 200])
  const ids = await Promise.all(created.map(async value => (await value.json() as any).data.id))
  expect(ids[0]).not.toBe(ids[1])
  const replayed = await Promise.all(requests.map((request, index) => httpManaged(f, request, f.cookie, workers[1 - index].url)))
  expect(replayed.map(value => value.status)).toEqual([401, 401])
})
it('runs all eight operations against actual Native Discussion with separate Meta identity and live PG authority', async () => {
  const f = await fixture(); const created = await f.run(await f.req()) as { id: string; comments: { author_user_id: number }[] }
  expect(created.comments[0].author_user_id).toBe(42)
  const read = await f.run(await f.req({ operation: 'thread', threadId: created.id })) as { id: string }
  expect(read.id).toBe(created.id)
  const list = await f.run(await f.req({ operation: 'list' })) as { threads: { id: string }[] }
  expect(list.threads.some(item => item.id === created.id)).toBe(true)
  const replied = await f.run(await f.req({ operation: 'comment', threadId: created.id, body: { body: 'reply' } })) as { comments: { id: string; author_user_id: number }[] }
  const comment = replied.comments.at(-1)!; expect(comment.author_user_id).toBe(42)
  const edited = await f.run(await f.req({ operation: 'edit', threadId: created.id, commentId: comment.id, body: { body: 'edited' } })) as { comments: { id: string; body: string }[] }
  expect(edited.comments.find(item => item.id === comment.id)?.body).toBe('edited')
  const resolved = await f.run(await f.req({ operation: 'resolve', threadId: created.id, body: {} })) as { status: string }; expect(resolved.status).toBe('resolved')
  const reopened = await f.run(await f.req({ operation: 'reopen', threadId: created.id, body: {} })) as { status: string }; expect(reopened.status).toBe('open')
  const deleted = await f.run(await f.req({ operation: 'delete', threadId: created.id, commentId: comment.id })) as { comments: { id: string; body: string | null }[] }
  expect(deleted.comments.find(item => item.id === comment.id)?.body).toBeNull()
})
it.each([
  ['session', "UPDATE plm_managed_sessions SET meta_tenant_id='default' WHERE id=$1"],
  ['session', "UPDATE plm_managed_sessions SET meta_org_id='fixture-org' WHERE id=$1"],
  ['session', 'UPDATE plm_managed_sessions SET revoked_at=now() WHERE id=$1'],
  ['source', "UPDATE data_sources SET owner_id='other' WHERE id=$1"],
  ['actor', 'UPDATE users SET is_active=false WHERE id=$1'],
  ['actor', "UPDATE user_orgs SET is_active=false WHERE user_id=$1 AND org_id='meta-org'"],
] as const)('refuses current SQL identity change %s %s before Native exchange', async (selector, sql) => {
  const f = await fixture(); const request = await f.req(); const before = exchangeCalls
  await pool.query(sql, [f[selector]])
  await expect(f.run(request)).rejects.toMatchObject({ status: 403 })
  expect(exchangeCalls).toBe(before)
})
it.each([
  ['session', "UPDATE plm_managed_sessions SET native_subject='meta-owner' WHERE id=$1", 'plm_managed_session_immutable'],
  ['link', 'UPDATE plm_managed_identity_links SET generation=2 WHERE id=$1', 'plm_managed_link_immutable'],
] as const)('keeps immutable %s identity protected by the actual database trigger', async (selector, sql, message) => {
  const f = await fixture(); const request = await f.req()
  await expect(pool.query(sql, [f[selector]])).rejects.toThrow(message)
  const result = await f.run(request) as { comments: { author_user_id: number }[] }
  expect(result.comments[0].author_user_id).toBe(42)
})
it('holds the same link lock through the real Native operation and serializes unlink state', async () => {
  const f = await fixture(); let unblock!: () => void, enteredResolve!: () => void
  const reached = new Promise<void>(resolve => { enteredResolve = resolve })
  release = new Promise<void>(resolve => { unblock = resolve }); entered = enteredResolve
  const pending = f.run(await f.req()); await reached
  const writer = await pool.connect(); const pid = (await writer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
  try {
    await writer.query('BEGIN')
    const stopped = writer.query("UPDATE plm_managed_identity_links SET status='revoked',stopped_at=now(),stop_reason='revoked' WHERE id=$1", [f.link])
    await waitFor(async () => (await pool.query("SELECT wait_event_type='Lock' AS waiting FROM pg_stat_activity WHERE pid=$1", [pid])).rows[0]?.waiting === true)
    unblock(); const result = await pending as { comments: { author_user_id: number }[] }
    expect(result.comments[0].author_user_id).toBe(42)
    await stopped; await writer.query('COMMIT')
    const before = exchangeCalls
    await expect(f.run(await f.req())).rejects.toMatchObject({ status: 403 }); expect(exchangeCalls).toBe(before)
  } finally { unblock(); entered = undefined; release = undefined; await writer.query('ROLLBACK'); writer.release() }
})
it.each(['link', 'membership'] as const)('rechecks session expiry after waiting for the actual %s lock', async lockKind => {
  const f = await fixture(1), request = await f.req(); const writer = await pool.connect()
  try {
    await writer.query('BEGIN')
    if (lockKind === 'link') await writer.query('SELECT id FROM plm_managed_identity_links WHERE id=$1 FOR UPDATE', [f.link])
    else await writer.query("SELECT user_id FROM user_orgs WHERE user_id=$1 AND org_id='meta-org' FOR UPDATE", [f.actor])
    const before = exchangeCalls; const pending = f.run(request)
    const pattern = lockKind === 'link' ? 'SELECT id FROM plm_managed_identity_links%' : 'SELECT org_id FROM user_orgs%'
    await waitFor(async () => (await pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE $1", [pattern])).rows[0].n > 0)
    await waitFor(async () => (await pool.query('SELECT expires_at<clock_timestamp() AS expired FROM plm_managed_sessions WHERE id=$1', [f.session])).rows[0].expired)
    await writer.query('COMMIT')
    const outcome = await pending.then(data => ({ accepted: true, data }), error => ({ accepted: false, status: error.status }))
    const expiry = (await pool.query('SELECT expires_at,clock_timestamp() AS checked_at,expires_at<clock_timestamp() AS expired FROM plm_managed_sessions WHERE id=$1', [f.session])).rows[0]
    const proof = { ...expiry, accepted: outcome.accepted, exchange_before: before, exchange_after: exchangeCalls,
      ...(outcome.accepted ? { native_thread: (outcome as { data: { id: string } }).data.id } : { status: (outcome as { status: number }).status }) }
    if (process.env.PLM_MANAGED_DISCUSSION_EXPIRY_PROOF) writeFileSync(process.env.PLM_MANAGED_DISCUSSION_EXPIRY_PROOF.replace('.json', '-' + lockKind + '.json'), JSON.stringify(proof, null, 2))
    expect(outcome).toMatchObject({ accepted: false, status: 403 }); expect(exchangeCalls).toBe(before)
  } finally { await writer.query('ROLLBACK'); writer.release() }
})


async function delegatedFixture() {
  const verifier = randomBytes(32).toString('base64url')
  const response = await fetch(native + '/api/v1/auth/managed-login/authorize', { method: 'POST',
    headers: { 'Content-Type': 'application/json', origin: native, Cookie: uiCookie, 'x-yuantus-ui-request': 'managed-login' },
    body: JSON.stringify({ client_id: 'discussion-client', callback: 'https://meta.example.test/api/plm/managed-login/callback',
      origin: 'https://meta.example.test', tenant_id: 'default', org_id: 'fixture-org', issuer: installationIssuer, root_part_id: 'part',
      state: randomUUID(), code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' }) })
  expect(response.status).toBe(200)
  const callback = new URL((await response.json() as { redirect_url: string }).redirect_url)
  const exchanged = await fetch(native + '/api/v1/auth/managed-login/exchange', { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-tenant-id': 'default', 'x-org-id': 'fixture-org' },
    body: JSON.stringify({ client_id: 'discussion-client', client_secret: 'owned-client-secret',
      code: callback.searchParams.get('code'), code_verifier: verifier, callback: 'https://meta.example.test/api/plm/managed-login/callback' }) })
  expect(exchanged.status).toBe(200)
  const issued = await exchanged.json() as { delegation_id: string; credential: string; expires_in: number }
  expect(issued.credential.startsWith('yur_')).toBe(true)
  const f = await fixture(Math.min(issued.expires_in - 2, 300), issued)
  const jwt = signManagedSessionToken({ userId: f.actor, email: 'owned@example.test', role: 'user',
    tenantId: 'meta-tenant', sessionId: f.session, expiresAt: f.expiresAt })
  return { ...f, jwt, cookie: 'ms_plm_managed_session=' + jwt }
}
async function httpManaged(f: Awaited<ReturnType<typeof fixture>>, request: Request, cookie?: string, origin = metaUrl) {
  return fetch(origin + '/api/plm/managed-login/sources/' + f.source + '/discussion', { method: 'POST',
    headers: { ...(request.headers as Record<string, string>), ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(request.body) })
}
it('mounted global cookie gate requires independent Native Discussion authority and real live delegation', async () => {
  const f = await delegatedFixture(); expect(isWhitelisted('/api/plm/managed-login/sources/' + f.source + '/discussion')).toBe(false)
  const before = exchangeCalls, request = await f.req()
  expect((await httpManaged(f, request)).status).toBe(401)
  const noEmbed = { ...request, headers: { origin: 'https://meta.example.test', 'content-type': 'application/json' } } as Request
  expect((await httpManaged(f, noEmbed, f.cookie)).status).toBe(401)
  expect(exchangeCalls).toBe(before)
  const response = await httpManaged(f, request, f.cookie)
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ ok: true, data: { comments: [{ author_user_id: 42 }] } })
})
it('mounted route rejects another valid Meta source owner even for the same Native person', async () => {
  const first = await delegatedFixture(), other = await delegatedFixture(), request = await first.req(), before = exchangeCalls
  expect((await httpManaged(first, request, other.cookie)).status).toBe(403)
  expect(exchangeCalls).toBe(before)
  expect((await httpManaged(other, request, other.cookie)).status).toBe(200)
})
it('mounted route rejects a revoked real Native delegation while first-party Native credentials remain valid', async () => {
  const f = await delegatedFixture(), request = await f.req(), before = exchangeCalls
  const revoked = await fetch(native + '/api/v1/auth/managed-login/revoke', { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-tenant-id': 'default', 'x-org-id': 'fixture-org' },
    body: JSON.stringify({ client_id: 'discussion-client', client_secret: 'owned-client-secret', delegation_id: f.delegation }) })
  expect(revoked.status).toBe(204)
  expect((await httpManaged(f, request, f.cookie)).status).toBe(401)
  expect(exchangeCalls).toBe(before)
  const restored = await delegatedFixture()
  expect((await httpManaged(restored, await restored.req(), restored.cookie)).status).toBe(200)
})
it('mounted live Meta user refusal does not burn the independent Native embed token', async () => {
  const f = await delegatedFixture(), request = await f.req(), before = exchangeCalls
  await pool.query('UPDATE users SET is_active=false WHERE id=$1', [f.actor])
  expect((await httpManaged(f, request, f.cookie)).status).toBe(401); expect(exchangeCalls).toBe(before)
  await pool.query('UPDATE users SET is_active=true WHERE id=$1', [f.actor])
  expect((await httpManaged(f, request, f.cookie)).status).toBe(200)
})

it('uses current persisted source URL and leaves a refused token usable after valid source restoration', async () => {
  const f = await fixture(), request = await f.req(), before = exchangeCalls
  const original = (await pool.query('SELECT config FROM data_sources WHERE id=$1', [f.source])).rows[0].config
  await pool.query("UPDATE data_sources SET config=jsonb_set(config,'{connection,url}',to_jsonb((config#>>'{connection,url}')||'/other-installation')) WHERE id=$1", [f.source])
  await expect(f.run(request)).rejects.toMatchObject({ code: 'PLM_MANAGED_DISCUSSION_SOURCE_CHANGED' }); expect(exchangeCalls).toBe(before)
  await pool.query('UPDATE data_sources SET config=$2::jsonb WHERE id=$1', [f.source, JSON.stringify(original)])
  expect(await f.run(request)).toMatchObject({ comments: [{ author_user_id: 42 }] })
})
it('mounted scoped credentials cannot act on an existing foreign root readable by the first-party Native user', async () => {
  const f = await delegatedFixture()
  const foreign = await fetch(native + '/api/v1/discussions', { method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + bearer },
    body: JSON.stringify({ target_type: 'item', target_id: 'other-part', body: 'Native-authorized foreign-root thread' }) })
  expect(foreign.status).toBe(200); const thread = await foreign.json() as { id: string }
  const nativeRead = await fetch(native + '/api/v1/discussions/' + thread.id, { headers: { Authorization: 'Bearer ' + bearer } })
  expect(nativeRead.status).toBe(200)
  const attempt = await httpManaged(f, await f.req({ operation: 'create', body: { target_type: 'item', target_id: 'other-part', body: 'Must be refused' } }), f.cookie)
  expect(attempt.status).toBe(403)
  const existing = await httpManaged(f, await f.req({ operation: 'thread', threadId: thread.id }), f.cookie)
  const absent = await httpManaged(f, await f.req({ operation: 'thread', threadId: randomUUID() }), f.cookie)
  expect(existing.status).toBe(404); expect(absent.status).toBe(404)
  expect(await existing.json()).toEqual(await absent.json())
  expect((await httpManaged(f, await f.req(), f.cookie)).status).toBe(200)
})
it('actual unlink waits for the admitted Native operation, freezes revocation identity and stops new HTTP calls', async () => {
  const f = await delegatedFixture(); let unblock!: () => void, enteredResolve!: () => void
  const reached = new Promise<void>(resolve => { enteredResolve = resolve })
  release = new Promise<void>(resolve => { unblock = resolve }); entered = enteredResolve
  const pending = httpManaged(f, await f.req(), f.cookie)
  await reached
  const stopped = fetch(metaUrl + '/api/plm/managed-login/unlink', { method: 'POST',
    headers: { 'Content-Type': 'application/json', origin: 'https://meta.example.test', Cookie: f.cookie },
    body: JSON.stringify({ dataSourceId: f.source }) })
  try {
    await waitFor(async () => (await pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE 'SELECT * FROM plm_managed_identity_links%'")).rows[0].n > 0)
    unblock(); expect((await pending).status).toBe(200)
    const response = await stopped; expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ ok: true, state: 'acked' })
    const frozen = (await pool.query('SELECT delegation_id,native_tenant_id,native_org_id,client_id,callback,status FROM plm_managed_revoke_outbox WHERE link_id=$1', [f.link])).rows
    expect(frozen).toEqual([{ delegation_id: f.delegation, native_tenant_id: 'default', native_org_id: 'fixture-org',
      client_id: 'discussion-client', callback: 'https://meta.example.test/api/plm/managed-login/callback', status: 'acked' }])
    const before = exchangeCalls
    expect((await httpManaged(f, await f.req(), f.cookie)).status).toBe(401); expect(exchangeCalls).toBe(before)
  } finally { unblock(); entered = undefined; release = undefined; await pending; await stopped }
})


it('two actual Meta processes share replay admission: one Native write and fresh token recovery on the other worker', async () => {
  const f = await delegatedFixture(), request = await f.req()
  const before = exchangeCalls
  const responses = await Promise.all(workers.map(worker => httpManaged(f, request, f.cookie, worker.url)))
  expect(responses.map(response => response.status).sort()).toEqual([200, 401])
  expect(exchangeCalls).toBe(before + 1)
  const winner = responses.findIndex(response => response.status === 200)
  const created = (await responses[winner].json() as { data: { id: string; comments: { author_user_id: number }[] } }).data
  expect(created.comments).toHaveLength(1); expect(created.comments[0].author_user_id).toBe(42)
  const recovered = await httpManaged(f, await f.req({ operation: 'thread', threadId: created.id }), f.cookie, workers[1 - winner].url)
  expect(recovered.status).toBe(200)
  expect((await recovered.json() as { data: { id: string } }).data.id).toBe(created.id)
})

it('read and write races across actual Meta processes consume one shared embed token with a fresh-token positive', async () => {
  const f = await delegatedFixture(), request = await f.req()
  const before = exchangeCalls
  const responses = await Promise.all([
    httpManaged(f, { ...request, body: { operation: 'list' } } as Request, f.cookie, workers[0].url),
    httpManaged(f, request, f.cookie, workers[1].url),
  ])
  expect(responses.map(response => response.status).sort()).toEqual([200, 401])
  expect(exchangeCalls).toBe(before + 1)
  const fresh = await httpManaged(f, await f.req({ operation: 'list' }), f.cookie, workers[0].url)
  expect(fresh.status).toBe(200)
})

it('unlink in another Meta process waits for the admitted Native operation and stops both workers', async () => {
  const f = await delegatedFixture(), request = await f.req()
  let unblock!: () => void, admitted!: () => void
  const admission = new Promise<void>(resolve => { admitted = resolve })
  entered = admitted; release = new Promise<void>(resolve => { unblock = resolve })
  let write: Promise<Response> | undefined, unlink: Promise<Response> | undefined
  try {
    write = httpManaged(f, request, f.cookie, workers[0].url)
    await admission
    unlink = fetch(workers[1].url + '/api/plm/managed-login/unlink', {
      method: 'POST', headers: { Cookie: f.cookie, Origin: 'https://meta.example.test', 'Content-Type': 'application/json' }, body: JSON.stringify({ dataSourceId: f.source }),
    })
    await waitFor(async () => (await pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type='Lock' AND query ILIKE '%plm_managed_identity_links%'")).rows[0].n > 0)
    unblock(); expect((await write).status).toBe(200); expect((await unlink).status).toBe(200)
    const before = exchangeCalls
    for (const worker of workers) expect((await httpManaged(f, await f.req(), f.cookie, worker.url)).status).toBe(401)
    expect(exchangeCalls).toBe(before)
    const fresh = await delegatedFixture()
    expect((await httpManaged(fresh, await fresh.req(), fresh.cookie, workers[1].url)).status).toBe(200)
  } finally { unblock(); entered = undefined; release = undefined; await Promise.allSettled([write, unlink]) }
})


async function contextRequest(f: Awaited<ReturnType<typeof delegatedFixture>>, parentOrigin = proxy) {
  return f.req({ operation: 'context', parentOrigin })
}
async function contextResponse(request: Request, cookie?: string) {
  return fetch(metaUrl + '/api/plm/managed-login/discussion-context', { method: 'POST',
    headers: { ...(request.headers as Record<string, string>), ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(request.body) })
}
it('managed frame context requires the actual managed cookie and fresh Native token, then spends it without a Discussion exchange', async () => {
  const f = await delegatedFixture(), request = await contextRequest(f), before = exchangeCalls
  expect(isWhitelisted('/api/plm/managed-login/discussion-context')).toBe(false)
  expect((await contextResponse(request)).status).toBe(401)
  const response = await contextResponse(request, f.cookie)
  expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store')
  expect(await response.json()).toEqual({ ok: true, data: { sourceId: f.source, partId: 'part', parentOrigin: proxy } })
  expect((await contextResponse(request, f.cookie)).status).toBe(401)
  expect(exchangeCalls).toBe(before)
})
it('managed frame context refuses forged parent and caller-selected source before token consumption', async () => {
  const f = await delegatedFixture(), request = await contextRequest(f, native), before = exchangeCalls
  expect((await contextResponse(request, f.cookie)).status).toBe(403)
  request.body = { operation: 'context', parentOrigin: proxy, sourceId: randomUUID() }
  expect((await contextResponse(request, f.cookie)).status).toBe(422)
  request.body = { operation: 'context', parentOrigin: proxy }
  expect((await contextResponse(request, f.cookie)).status).toBe(200)
  expect(exchangeCalls).toBe(before)
})
it('managed frame discovery resolves each current cookie source rather than the latest or a global source', async () => {
  const a = await delegatedFixture(), b = await delegatedFixture()
  expect(a.source).not.toBe(b.source)
  for (const f of [a, b]) {
    const response = await contextResponse(await contextRequest(f), f.cookie)
    expect(response.status).toBe(200)
    expect((await response.json() as { data: { sourceId: string } }).data.sourceId).toBe(f.source)
  }
})


function ownedNativeVisual(command: string, ...args: string[]) {
  const python = process.env.PLM_MANAGED_VISUAL_PYTHON, nativeTree = process.env.PLM_MANAGED_VISUAL_NATIVE_TREE
  if (!python || !nativeTree || !process.env.PLM_MANAGED_VISUAL_FIXTURE_ROOT) throw new Error('Owned Native Visual fixture required')
  const result = spawnSync(python, [resolve('tests/integration/fixtures/seed-managed-visual-native.py'), command, ...args], {
    cwd: nativeTree, env: process.env, encoding: 'utf8', timeout: 20000,
  })
  expect(result.status, result.stderr).toBe(0)
  return result.stdout
}
async function visualFixture() {
  const f = await delegatedFixture()
  await pool.query("UPDATE data_sources SET config=jsonb_set(config,'{options,managedVisualReviewEnabled}','true') WHERE id=$1", [f.source])
  return f
}
async function actualVisualImage(f: Awaited<ReturnType<typeof delegatedFixture>>, worker = metaUrl) {
  const request = await f.req({ operation: 'preview-image', fileId: 'managed-visual-file', versionId: 'managed-visual-v1' })
  const response = await httpManaged(f, request, f.cookie, worker)
  expect(response.status).toBe(200)
  expect(response.headers.get('content-type')).toMatch(/^image\/png/)
  const descriptor = JSON.parse(Buffer.from(response.headers.get('X-PLM-Preview-Descriptor')!, 'base64url').toString())
  const bytes = Buffer.from(await response.arrayBuffer())
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(descriptor.preview_checksum)
  expect(descriptor).toMatchObject({ part_id: 'part', file_id: 'managed-visual-file', file_version: 'managed-visual-v1',
    version_is_current: true, preview_width: 4, preview_height: 5 })
  return descriptor
}
function visualBody(descriptor: Record<string, any>) {
  return { target_type: 'item', target_id: 'part', body: 'Actual managed Visual pin',
    anchor: { kind: 'cad_2d_markup', file_id: descriptor.file_id, file_version: descriptor.file_version,
      content_checksum: descriptor.content_checksum, preview_checksum: descriptor.preview_checksum, page: 0 },
    markup: { schema_version: 1, markup_type: 'pin', file_id: descriptor.file_id,
      geometry: { x: 0.25, y: 0.5 }, viewport: { width: descriptor.preview_width, height: descriptor.preview_height, rotation: 0 } } }
}
it('managed Visual actual provider raster and bound markup survive independent Meta workers', async () => {
  const f = await visualFixture()
  const list = await httpManaged(f, await f.req({ operation: 'preview-files' }), f.cookie, workers[0].url)
  expect(list.status).toBe(200)
  expect((await list.json() as any).data.files).toContainEqual({ file_id: 'managed-visual-file', version_id: 'managed-visual-v1', filename: 'owned.png', version_is_current: true })
  const descriptor = await actualVisualImage(f, workers[1].url)
  const created = await httpManaged(f, await f.req({ operation: 'create', body: visualBody(descriptor) }), f.cookie, workers[0].url)
  expect(created.status).toBe(200)
  const thread = (await created.json() as any).data
  expect(thread.comments[0]).toMatchObject({ author_user_id: 42, markup: { binding_state: 'bound', file_id: 'managed-visual-file', file_version: 'managed-visual-v1' } })
  const reread = await httpManaged(f, await f.req({ operation: 'thread', threadId: thread.id }), f.cookie, workers[1].url)
  expect(reread.status).toBe(200)
  const comments = (await reread.json() as any).data.comments
  // PostgreSQL reload may serialize the same instant in its configured timezone.
  const normalizedTimes = (values: any[]) => values.map(value => ({ ...value, created_at: new Date(value.created_at).toISOString() }))
  expect(normalizedTimes(comments)).toEqual(normalizedTimes(thread.comments))
  const restore = JSON.parse(ownedNativeVisual('restore-domain', thread.id))
  expect(restore.domain_equal).toBe(true)
  expect(restore.image_sha256).toBe(descriptor.preview_checksum)
  const socket = createServer(); await new Promise<void>(resolve => socket.listen(0, '127.0.0.1', resolve))
  const port = (socket.address() as { port: number }).port
  await new Promise<void>(resolve => socket.close(() => resolve()))
  const root = process.env.PLM_MANAGED_VISUAL_FIXTURE_ROOT!
  const restoredUrl = 'http://127.0.0.1:' + port
  const restoredNative = spawn(process.env.PLM_MANAGED_VISUAL_PYTHON!, ['-m', 'uvicorn', 'yuantus.api.app:app', '--host', '127.0.0.1', '--port', String(port)], {
    cwd: root, env: { ...process.env,
      YUANTUS_DATABASE_URL_TEMPLATE: process.env.YUANTUS_DATABASE_URL_TEMPLATE!.replace('/native_{tenant_id}_{org_id}?', '/restored_native_{tenant_id}_{org_id}?'),
      YUANTUS_LOCAL_STORAGE_PATH: root + '/visual-restored-storage' }, stdio: ['ignore', 'ignore', 'pipe'],
  })
  let shutdown = ''
  restoredNative.stderr?.on('data', bytes => { shutdown = (shutdown + bytes).slice(-4000) })
  const exit = new Promise<{ code: number | null; signal: string | null }>(resolve => restoredNative.once('exit', (code, signal) => resolve({ code, signal })))
  try {
    await waitFor(async () => { try { return (await fetch(restoredUrl + '/api/v1/health')).ok } catch { return false } })
    const restoredThread = await fetch(restoredUrl + '/api/v1/discussions/' + thread.id, { headers: { Authorization: 'Bearer ' + bearer } })
    expect(restoredThread.status).toBe(200)
    const actual = await restoredThread.json() as any
    expect(actual.comments[0]).toMatchObject({ id: thread.comments[0].id, body: 'Actual managed Visual pin', author_user_id: 42,
      markup: { file_id: 'managed-visual-file', file_version: 'managed-visual-v1', preview_checksum: descriptor.preview_checksum, geometry: { x: 0.25, y: 0.5 } } })
    const request = await f.req({ operation: 'preview-files' })
    const minted = await fetch(restoredUrl + '/api/v1/auth/embed/visual-preview-session', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ embed_token: request.headers['x-plm-embed-token'],
        file_id: descriptor.file_id, version_id: descriptor.file_version }) })
    expect(minted.status).toBe(200)
    const capability = await minted.json() as any
    expect(capability.render).toBe('available')
    const raster = await fetch(restoredUrl + '/api/v1/auth/embed/visual-preview-session', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ preview_token: capability.preview_token, origin: 'https://meta.example.test' }) })
    expect(raster.status).toBe(200)
    expect(raster.headers.get('content-type')).toMatch(/^image\/png/)
    restore.restored_preview_sha256 = createHash('sha256').update(Buffer.from(await raster.arrayBuffer())).digest('hex')
    expect(restore.restored_preview_sha256).toBe(descriptor.preview_checksum)
    restore.restored_api_status = restoredThread.status
    restore.restored_preview_status = raster.status
  } finally {
    restoredNative.kill('SIGTERM')
    let timeout: ReturnType<typeof setTimeout> | undefined
    const result = await Promise.race([exit, new Promise<never>((_, reject) => { timeout = setTimeout(() => { restoredNative.kill('SIGKILL'); reject(new Error('Restored Native shutdown timeout')) }, 10000) })])
    clearTimeout(timeout)
    expect((result.code === 0 || result.signal === 'SIGTERM') && shutdown.includes('Application shutdown complete.')).toBe(true)
    restore.restored_worker = { pid: restoredNative.pid, ...result, stopped: true }
  }
  if (process.env.PLM_MANAGED_VISUAL_RESTORE_PROOF) writeFileSync(process.env.PLM_MANAGED_VISUAL_RESTORE_PROOF, JSON.stringify(restore))
})
it('managed Visual actual Native rejects a forged checksum and stale version while current descriptor succeeds', async () => {
  const f = await visualFixture(), descriptor = await actualVisualImage(f)
  const bad = visualBody({ ...descriptor, preview_checksum: '0'.repeat(64) })
  const refused = await httpManaged(f, await f.req({ operation: 'create', body: bad }), f.cookie)
  expect(refused.status).toBe(422)
  ownedNativeVisual('stale-version')
  try {
    const stale = await httpManaged(f, await f.req({ operation: 'create', body: visualBody(descriptor) }), f.cookie)
    expect(stale.status).toBe(422)
  } finally { ownedNativeVisual('restore-version') }
  const accepted = await httpManaged(f, await f.req({ operation: 'create', body: visualBody(descriptor) }), f.cookie)
  expect(accepted.status).toBe(200)
})
it('managed Visual actual Native entitlement fails closed and resumes only after restoration', async () => {
  const f = await visualFixture()
  ownedNativeVisual('disable-license')
  try {
    const refused = await httpManaged(f, await f.req({ operation: 'preview-files' }), f.cookie)
    expect(refused.status).toBe(503)
  } finally { ownedNativeVisual('restore-license') }
  expect((await httpManaged(f, await f.req({ operation: 'preview-files' }), f.cookie)).status).toBe(200)
  const fresh = await f.req({ operation: 'preview-files' })
  ownedNativeVisual('revoke-acl')
  const before = nativePreviewStatuses.length
  try {
    expect((await httpManaged(f, fresh, f.cookie, workers[0].url)).status).toBe(503)
    expect(nativePreviewStatuses.slice(before)).toEqual([401])
  }
  finally { ownedNativeVisual('restore-acl') }
  await actualVisualImage(f, workers[1].url)
  expect(nativePreviewStatuses.slice(-2)).toEqual([200, 200])
})
it('managed Visual actual delegation revocation stops preview before new Native capability calls', async () => {
  const f = await visualFixture()
  await actualVisualImage(f)
  const revoked = await fetch(native + '/api/v1/auth/managed-login/revoke', { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-tenant-id': 'default', 'x-org-id': 'fixture-org' },
    body: JSON.stringify({ client_id: 'discussion-client', client_secret: 'owned-client-secret', delegation_id: f.delegation }) })
  expect(revoked.status).toBe(204)
  const before = exchangeCalls
  expect((await httpManaged(f, await f.req({ operation: 'preview-files' }), f.cookie)).status).toBe(401)
  expect(exchangeCalls).toBe(before)
})
