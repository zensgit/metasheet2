/** Actual PostgreSQL authority locks, production Redis and real Native API.
 * Meta session/identity rows are provisioned; this is not global JWT/cookie acceptance.
 */
import { beforeAll, afterAll, it, expect } from 'vitest'
import { randomUUID, randomBytes, createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
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
let server: Server, metaServer: Server, metaUrl: string, proxy: string, bearer: string, uiCookie: string
let entered: (() => void) | undefined, release: Promise<void> | undefined
let exchangeCalls = 0
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
      res.statusCode = response.status; res.setHeader('Content-Type', 'application/json'); res.end(await response.text())
    } catch { res.statusCode = 502; res.end('{}') }
  })
  await new Promise<void>(resolve => server.listen(Number(process.env.PLM_MANAGED_DISCUSSION_PROXY_PORT ?? 0), '127.0.0.1', resolve))
  proxy = 'http://127.0.0.1:' + (server.address() as { port: number }).port
  process.env.PLM_MANAGED_COMPANION_ENABLED = 'true'
  process.env.PLM_MANAGED_COMPANION_CLIENTS_JSON = JSON.stringify([{ issuer: proxy,
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
})
afterAll(async () => {
  entered = undefined; release = undefined
  metaServer.closeAllConnections(); await new Promise<void>(resolve => metaServer.close(() => resolve()))
  server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
  await closeRedisClient(); await poolManager.close(); await pool.end()
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
    [link, proxy, 'https://meta.example.test/api/plm/managed-login/callback', actor, source, fp])
  await pool.query(`INSERT INTO plm_managed_browser_intents(id,link_id,generation,meta_user_id,meta_tenant_id,meta_org_id,data_source_id,root_part_id,client_origin,installation_issuer,native_tenant_id,native_org_id,callback,client_id,state_hash,nonce_hash,code_challenge,code_verifier_ciphertext,return_path,status,expires_at,consumed_at,delegation_id,credential_ciphertext)
    VALUES($1,$2,1,$3,'meta-tenant','meta-org',$4,'part','https://meta.example.test',$5,'default','fixture-org',$6,'discussion-client',$7,$7,$8,'enc:fixture','/plm/bom-review','consumed',now()+interval '5 minutes',now(),$9,'enc:read-fixture')`,
    [intent, link, actor, source, proxy, 'https://meta.example.test/api/plm/managed-login/callback', 'a'.repeat(64), 'a'.repeat(43), delegation])
  await pool.query("INSERT INTO plm_managed_source_bindings(data_source_id,link_id,generation,source_fingerprint,status,frozen_origin,frozen_root_part_id)VALUES($1,$2,1,$3,'active',$4,'part')", [source, link, fp, proxy])
  await pool.query(`INSERT INTO plm_managed_sessions(id,intent_id,link_id,data_source_id,generation,delegation_id,credential_ciphertext,expires_at,scope,native_subject,native_tenant_id,native_org_id,meta_user_id,meta_tenant_id,meta_org_id,root_part_id,client_origin,installation_issuer,client_id)
    VALUES($1,$2,$3,$4,1,$5,$9,now()+make_interval(secs=>$8),'bom_review_read','42','default','fixture-org',$6,'meta-tenant','meta-org','part','https://meta.example.test',$7,'discussion-client')`,
    [session, intent, link, source, delegation, actor, proxy, seconds, ciphertext])
  async function req(body: unknown = { operation: 'create', body: { target_type: 'item', target_id: 'part', body: 'Managed real Native comment' } }) {
    const response = await fetch(native + '/api/v1/bom/multitable/part/embed-token', { method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + bearer, 'x-tenant-id': 'default', 'x-org-id': 'fixture-org' },
      body: JSON.stringify({ origin: 'https://meta.example.test' }) })
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
      origin: 'https://meta.example.test', tenant_id: 'default', org_id: 'fixture-org', issuer: proxy, root_part_id: 'part',
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
async function httpManaged(f: Awaited<ReturnType<typeof fixture>>, request: Request, cookie?: string) {
  return fetch(metaUrl + '/api/plm/managed-login/sources/' + f.source + '/discussion', { method: 'POST',
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
