import { randomUUID } from 'node:crypto'
import express from 'express'
import jwt from 'jsonwebtoken'
import pg from 'pg'
import request from 'supertest'
import { expect, vi } from 'vitest'
import { poolManager } from '../../src/integration/db/connection-pool'

type CanonicalUnionScenario = { mixed: boolean; knownOpenId: boolean; grant?: false; ambiguous?: true }

/** Run real routes and provider response decoders against one disposable SQL transaction.
 * The scope row is insert-only. Savepoints preserve application rollback without leaving a
 * committed scope in the shared integration database. Only the provider's HTTP wire is stubbed. */
export async function checkDingTalkLoginSurfaces(canonical?: CanonicalUnionScenario): Promise<void> {
  const appKey = `login-app-${randomUUID()}`
  vi.stubEnv('DINGTALK_CLIENT_ID', appKey)
  vi.stubEnv('DINGTALK_CORP_ID', '')
  vi.stubEnv('DINGTALK_CONTAINER_LOGIN_ENABLED', 'true')
  vi.stubEnv('DINGTALK_OAUTH_REQUIRE_SHARED_STATE_STORE', 'false')
  const { authRouter } = await import('../../src/routes/auth')
  const { generateState } = await import('../../src/auth/dingtalk-oauth')
  const app = express().use(express.json()).use('/api/auth', authRouter)
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL })
  await client.connect()
  const pool = poolManager.get()
  const fixture = client.query.bind(client)
  const query = vi.spyOn(pool, 'query').mockImplementation((sql, params) => fixture(sql, params))
  const transaction = vi.spyOn(pool, 'transaction').mockImplementation(async (handler) => {
    await fixture('SAVEPOINT login_request')
    try {
      const result = await handler({ query: fixture })
      await fixture('RELEASE SAVEPOINT login_request')
      return result
    } catch (error) {
      await fixture('ROLLBACK TO SAVEPOINT login_request')
      await fixture('RELEASE SAVEPOINT login_request')
      throw error
    }
  })
  let person = ''
  vi.stubGlobal('fetch', async (url: string | URL) => {
    const payload: Record<string, unknown> = {
      '/v1.0/oauth2/userAccessToken': { accessToken: 'fixture-web' },
      '/v1.0/contact/users/me': { openId: `open-${person}`, unionId: `union-${person}`, nick: 'Synthetic' },
      '/gettoken': { errcode: 0, access_token: 'fixture-app', expires_in: 3600 },
      '/topapi/v2/user/getuserinfo': { errcode: 0, result: { userid: person, unionid: `union-${person}` } },
      '/topapi/v2/user/get': { errcode: 0, result: { userid: person, unionid: `union-${person}`, name: 'Synthetic' } },
    }
    const endpoint = new URL(url).pathname
    if (!(endpoint in payload)) throw new Error('Unexpected provider operation')
    return new Response(JSON.stringify(payload[endpoint]), { headers: { 'Content-Type': 'application/json' } })
  })
  const ordinary = randomUUID(), strict = randomUUID()
  const bare = randomUUID(), known = randomUUID()
  async function connection(id: string, key: string) {
    await fixture(`INSERT INTO directory_integrations(id, org_id, provider, name, status, corp_id, config)
      VALUES ($1, 'login-test', 'dingtalk', $2, 'active', $2, $3)`, [id, `corp-${id}`, { appKey: key }])
  }
  async function send(surface: 'web' | 'container', user: string, selector?: string) {
    person = user
    const body = surface === 'web' ? { state: await generateState({ intent: 'login' }), code: 'fixture' } : { authCode: 'fixture' }
    return request(app).post('/api/auth/' + (surface === 'web' ? 'dingtalk/callback' : 'login/dingtalk/container'))
      .send({ ...body, corpId: selector })
  }
  async function login(surface: 'web' | 'container', user: string, expected: number, selector?: string) {
    const state = () => fixture(`SELECT e.updated_at, e.corp_id, e.external_key, g.enabled,
      e.ctid::text AS identity_version, g.ctid::text AS grant_version,
      (SELECT count(*)::int FROM user_sessions s WHERE s.user_id = e.local_user_id) AS sessions
      FROM user_external_identities e JOIN user_external_auth_grants g USING (local_user_id, provider) WHERE e.local_user_id=$1`, [user])
    const before = (await state()).rows
    const res = await send(surface, user, selector)
    expect(res.status, `${surface} ${res.body.code ?? ''}`).toBe(expected)
    if (expected === 403) {
      expect(res.body.code).toBe('strict_connection')
      expect(res.body.data?.token).toBeUndefined()
      expect((await state()).rows).toEqual(before)
      return
    }
    const claims = jwt.verify(res.body.data.token, process.env.JWT_SECRET!) as jwt.JwtPayload
    expect(claims.userId).toBe(user)
    expect(claims.xa).toBeFalsy()
    expect((await fixture('SELECT id FROM user_sessions WHERE user_id=$1 AND id=$2', [user, claims.sid])).rowCount).toBe(1)
  }
  try {
    await fixture('BEGIN ISOLATION LEVEL READ COMMITTED')
    expect((await fixture('SELECT 1 FROM directory_connection_login_scope LIMIT 1')).rowCount).toBe(0)
    await connection(ordinary, appKey)
    if (canonical) {
      const user = randomUUID()
      const corp = `corp-${ordinary}`, unionId = `union-${user}`, openId = `open-${user}`
      if (canonical.mixed) {
        await connection(strict, `other-${appKey}`)
        await fixture('INSERT INTO directory_connection_login_scope(connection_id, command_id) VALUES ($1,$2)', [strict, randomUUID()])
        if (canonical.ambiguous) await fixture('UPDATE directory_integrations SET corp_id=$1 WHERE id=$2', [corp, strict])
      }
      await fixture(`INSERT INTO users(id,email,name,password_hash,role,is_active,activation_status)
        VALUES ($1,$2,'Synthetic','fixture','user',true,'activated')`, [user, `${user}@example.invalid`])
      await fixture(`INSERT INTO user_external_identities(provider,local_user_id,external_key,provider_union_id,provider_open_id,corp_id)
        VALUES ('dingtalk',$1,$2,$3,$4,NULL)`, [user, `${corp}:${unionId}`, unionId, canonical.knownOpenId ? openId : null])
      await fixture("INSERT INTO user_external_auth_grants(provider,local_user_id,enabled) VALUES ('dingtalk',$1,$2)", [user, canonical.grant !== false])
      const readIdentity = async () => (await fixture(`SELECT external_key, provider_union_id, provider_open_id, corp_id
        FROM user_external_identities WHERE provider='dingtalk' AND local_user_id=$1`, [user])).rows
      const expected = { external_key: `${corp}:${unionId}`, provider_union_id: unionId, provider_open_id: openId, corp_id: null }
      if (canonical.grant === false) {
        const denied = await send('web', user)
        expect(denied.status).toBe(403)
        expect(denied.body.code).toBe('grant_required')
        expect(denied.body.data?.token).toBeUndefined()
        expect((await fixture('SELECT id FROM user_sessions WHERE user_id=$1', [user])).rows).toEqual([])
        expect(await readIdentity()).toEqual([expected])
        await fixture("UPDATE user_external_auth_grants SET enabled=true WHERE provider='dingtalk' AND local_user_id=$1", [user])
      }
      const initial = await readIdentity()
      const afterEachSurface = []
      for (const surface of ['web', 'container'] as const) {
        await login(surface, user, canonical.ambiguous ? 403 : 200)
        afterEachSurface.push(await readIdentity())
        const sessions = await fixture('SELECT external_auth_context FROM user_sessions WHERE user_id=$1', [user])
        const sessionCount = canonical.ambiguous ? 0 : surface === 'web' ? 1 : 2
        expect(sessions.rows).toEqual(Array.from({ length: sessionCount }, () => ({ external_auth_context: null })))
      }
      const expectedIdentity = canonical.ambiguous ? initial : [expected]
      expect(afterEachSurface).toEqual([expectedIdentity, expectedIdentity])
      expect((await fixture('SELECT directory_account_id FROM directory_account_links WHERE local_user_id=$1', [user])).rows).toEqual([])
      return
    }
    for (const id of [bare, known]) {
      await fixture(`INSERT INTO users(id,email,name,password_hash,role,is_active,activation_status)
        VALUES ($1,$2,'Synthetic','fixture','user',true,'activated')`, [id, `${id}@example.invalid`])
      await fixture(`INSERT INTO user_external_identities(provider,local_user_id,external_key,provider_union_id,provider_open_id,corp_id)
        VALUES ('dingtalk',$1,$2,$3,$4,$5)`, [id, id === bare ? `open-${id}` : `corp-${ordinary}:open-${id}`, `union-${id}`, `open-${id}`, id === bare ? null : `corp-${ordinary}`])
      await fixture("INSERT INTO user_external_auth_grants(provider,local_user_id,enabled) VALUES ('dingtalk',$1,true)", [id])
    }
    for (const surface of ['web', 'container'] as const) {
      await login(surface, bare, 200)
      await login(surface, known, 200)
      await login(surface, bare, 403, 'unmatched-fixture')
    }
    await connection(strict, `other-${appKey}`)
    await fixture('INSERT INTO directory_connection_login_scope(connection_id, command_id) VALUES ($1,$2)', [strict, randomUUID()])
    for (const id of [ordinary, strict]) {
      const account = randomUUID()
      await fixture(`INSERT INTO directory_accounts(id,integration_id,provider,corp_id,external_user_id,external_key,name,is_active,union_id)
        VALUES ($1,$2,'dingtalk',$3,$4,$4,'Synthetic',true,$5)`, [account, id, `corp-${id}`, randomUUID(), id === ordinary ? `union-${known}` : `other-${known}`])
      await fixture("INSERT INTO directory_account_links(directory_account_id,local_user_id,link_status) VALUES($1,$2,'linked')", [account, known])
    }
    for (const surface of ['web', 'container'] as const) {
      await login(surface, bare, 403)
      await login(surface, known, 200)
    }
  } finally {
    vi.unstubAllGlobals()
    transaction.mockRestore()
    query.mockRestore()
    try { await fixture('ROLLBACK') } finally { await client.end() }
  }
}
