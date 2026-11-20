import { randomUUID } from 'node:crypto'
import express from 'express'
import jwt from 'jsonwebtoken'
import pg from 'pg'
import request from 'supertest'
import { expect, vi } from 'vitest'
import { poolManager } from '../../src/integration/db/connection-pool'

type DirectoryAffiliation = 'sibling' | 'multiple' | 'foreign' | 'foreign among multiple' | 'different directory UnionID' | 'verified sole link' | 'configured bare sibling' | 'stored corporate OpenID' | 'configured stored corporate OpenID'
type AffiliationScenario = { mixed: boolean; affiliation: DirectoryAffiliation }
type CanonicalUnionScenario = { mixed: boolean; knownOpenId: boolean; grant?: false; ambiguous?: true; storedCorp?: true; configured?: true }

/** Run real routes and provider response decoders against one disposable SQL transaction.
 * The scope row is insert-only. Savepoints preserve application rollback without leaving a
 * committed scope in the shared integration database. Only the provider's HTTP wire is stubbed. */
export async function checkDingTalkLoginSurfaces(scenario?: CanonicalUnionScenario | AffiliationScenario): Promise<void> {
  const canonical = scenario && 'knownOpenId' in scenario ? scenario : undefined
  const appKey = `login-app-${randomUUID()}`
  vi.stubEnv('DINGTALK_CLIENT_ID', appKey)
  vi.stubEnv('DINGTALK_CORP_ID', '')
  vi.stubEnv('DINGTALK_CONTAINER_LOGIN_ENABLED', 'true')
  vi.stubEnv('AUTH_LOGIN_MAX_ATTEMPTS', '100')
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
  const connections: string[] = []
  async function connection(id: string, key: string, corp = `corp-${id}`) {
    connections.push(id)
    await fixture(`INSERT INTO directory_integrations(id, org_id, provider, name, status, corp_id, config)
      VALUES ($1, 'login-test', 'dingtalk', $2, 'active', $4, $3)`, [id, `corp-${id}`, { appKey: key }, corp])
  }
  async function send(surface: 'web' | 'container', user: string, selector?: string) {
    person = user
    const body = surface === 'web' ? { state: await generateState({ intent: 'login' }), code: 'fixture' } : { authCode: 'fixture' }
    return request(app).post('/api/auth/' + (surface === 'web' ? 'dingtalk/callback' : 'login/dingtalk/container'))
      .send({ ...body, corpId: selector })
  }
  async function login(surface: 'web' | 'container', user: string, expected: number, selector?: string) {
    // Scope the comparison to this fixture's user and integrations so unrelated CI traffic
    // cannot change its result. PostgreSQL tuple versions expose same-value updates too.
    const versions = () => fixture([
      ['users', 'id=$1'], ['user_orgs', 'user_id=$1'], ['user_roles', 'user_id=$1'],
      ['user_permissions', 'user_id=$1'], ['user_sessions', 'user_id=$1'], ['user_session_revocations', 'user_id=$1'],
      ['user_external_identities', 'local_user_id=$1'], ['user_external_auth_grants', 'local_user_id=$1'],
      ['user_external_identity_login_grants', 'local_user_id=$1'], ['directory_account_links', 'local_user_id=$1'],
      ['directory_accounts', 'integration_id=ANY($2::uuid[])'], ['directory_integrations', 'id=ANY($2::uuid[])'],
      ['directory_connection_login_scope', 'connection_id=ANY($2::uuid[])'],
    ].map(([table, where]) => `SELECT '${table}' AS relation, ctid::text AS version FROM ${table} WHERE ${where}`)
      .join(' UNION ALL ') + ' ORDER BY relation, version', [user, connections])
    const denied = expected === 403 || expected === 409
    const before = denied ? (await versions()).rows : []
    const res = await send(surface, user, selector)
    const label = [surface, selector ? 'explicit' : 'implicit', res.body.code ?? res.type].join(' ')
    expect(res.status, label).toBe(expected)
    if (denied) {
      expect(res.body.code).toBe(expected === 403 ? 'strict_connection' : 'identity_mismatch')
      expect(res.body.data?.token).toBeUndefined()
      expect((await versions()).rows).toEqual(before)
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
    if (scenario && 'affiliation' in scenario) {
      const user = randomUUID(), sibling = randomUUID(), foreign = randomUUID()
      const corp = `corp-${ordinary}`, unionId = `union-${user}`
      const configuredBare = scenario.affiliation === 'configured bare sibling'
      const configuredOld = scenario.affiliation === 'configured stored corporate OpenID'
      if (configuredBare || configuredOld) vi.stubEnv('DINGTALK_CORP_ID', corp)
      await connection(sibling, `sibling-${appKey}`, corp)
      await connection(foreign, `foreign-${appKey}`)
      if (scenario.mixed) {
        await connection(strict, `strict-${appKey}`)
        await fixture('INSERT INTO directory_connection_login_scope(connection_id, command_id) VALUES ($1,$2)', [strict, randomUUID()])
      }
      await fixture(`INSERT INTO users(id,email,name,password_hash,role,is_active,activation_status)
        VALUES ($1,$2,'Synthetic','fixture','user',true,'activated')`, [user, `${user}@example.invalid`])
      const oldOpenId = configuredOld || scenario.affiliation === 'stored corporate OpenID' ? `previous-${user}` : null
      const key = oldOpenId ? `${corp}:${oldOpenId}` : scenario.affiliation === 'verified sole link' ? `${corp}:${unionId}` : unionId
      await fixture(`INSERT INTO user_external_identities(provider,local_user_id,external_key,provider_union_id,provider_open_id,corp_id)
        VALUES ('dingtalk',$1,$2,$3,$4,NULL)`, [user, key, unionId, oldOpenId])
      await fixture("INSERT INTO user_external_auth_grants(provider,local_user_id,enabled) VALUES ('dingtalk',$1,true)", [user])
      const connections = {
        sibling: [sibling], multiple: [ordinary, sibling], foreign: [foreign],
        'foreign among multiple': [ordinary, sibling, foreign], 'different directory UnionID': [ordinary], 'verified sole link': [ordinary], 'configured bare sibling': [sibling], 'stored corporate OpenID': [sibling], 'configured stored corporate OpenID': [sibling],
      }[scenario.affiliation]
      const accountIds = connections.map(() => randomUUID()).sort()
      for (const [index, id] of connections.entries()) {
        const account = accountIds[index]
        await fixture(`INSERT INTO directory_accounts(id,integration_id,provider,corp_id,external_user_id,external_key,name,is_active,union_id)
          VALUES ($1,$2,'dingtalk',$3,$4,$4,'Synthetic',true,$5)`, [
          account, id, id === foreign ? `corp-${foreign}` : corp, randomUUID(),
          scenario.affiliation === 'different directory UnionID' ? `other-${user}` : unionId,
        ])
        await fixture("INSERT INTO directory_account_links(directory_account_id,local_user_id,link_status) VALUES($1,$2,'linked')", [account, user])
      }
      const exact = scenario.affiliation === 'verified sole link'
      const allowed = exact || (!scenario.mixed && !connections.includes(foreign) && !configuredBare && !configuredOld)
      for (const surface of ['container', 'web'] as const) {
        await login(surface, user, exact ? 200 : 403, corp)
        await login(surface, user, configuredBare ? 409 : allowed ? 200 : 403)
        if (oldOpenId) {
          const openId = allowed && surface === 'web' ? `open-${user}` : oldOpenId
          expect((await fixture('SELECT external_key, provider_open_id FROM user_external_identities WHERE local_user_id=$1', [user])).rows)
            .toEqual([{ external_key: `${corp}:${openId}`, provider_open_id: openId }])
        }
      }
      expect((await fixture('SELECT corp_id FROM user_external_identities WHERE local_user_id=$1', [user])).rows).toEqual([{ corp_id: null }])
      expect((await fixture('SELECT external_auth_context FROM user_sessions WHERE user_id=$1', [user])).rows)
        .toEqual(Array.from({ length: exact ? 4 : allowed ? 2 : 0 }, () => ({ external_auth_context: null })))
      return
    }
    if (canonical) {
      const user = randomUUID()
      const corp = `corp-${ordinary}`, unionId = `union-${user}`, openId = `open-${user}`
      if (canonical.configured) vi.stubEnv('DINGTALK_CORP_ID', corp)
      if (canonical.mixed || canonical.ambiguous) await connection(strict, `other-${appKey}`)
      if (canonical.ambiguous) await fixture('UPDATE directory_integrations SET corp_id=$1 WHERE id=$2', [corp, strict])
      if (canonical.mixed) await fixture('INSERT INTO directory_connection_login_scope(connection_id, command_id) VALUES ($1,$2)', [strict, randomUUID()])
      await fixture(`INSERT INTO users(id,email,name,password_hash,role,is_active,activation_status)
        VALUES ($1,$2,'Synthetic','fixture','user',true,'activated')`, [user, `${user}@example.invalid`])
      await fixture(`INSERT INTO user_external_identities(provider,local_user_id,external_key,provider_union_id,provider_open_id,corp_id)
        VALUES ('dingtalk',$1,$2,$3,$4,$5)`, [user, `${corp}:${unionId}`, unionId, canonical.knownOpenId ? openId : null, canonical.storedCorp ? corp : null])
      await fixture("INSERT INTO user_external_auth_grants(provider,local_user_id,enabled) VALUES ('dingtalk',$1,$2)", [user, canonical.grant !== false])
      const readIdentity = async () => (await fixture(`SELECT external_key, provider_union_id, provider_open_id, corp_id
        FROM user_external_identities WHERE provider='dingtalk' AND local_user_id=$1`, [user])).rows
      const expected = { external_key: `${corp}:${canonical.storedCorp ? openId : unionId}`, provider_union_id: unionId, provider_open_id: openId, corp_id: canonical.storedCorp ? corp : null }
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
      const refused = canonical.mixed && canonical.ambiguous
      const afterEachSurface = []
      for (const surface of ['web', 'container'] as const) {
        if (canonical.ambiguous) await login(surface, user, 403, corp)
        await login(surface, user, refused ? 403 : 200)
        afterEachSurface.push(await readIdentity())
        const sessions = await fixture('SELECT external_auth_context FROM user_sessions WHERE user_id=$1', [user])
        const sessionCount = refused ? 0 : surface === 'web' ? 1 : 2
        expect(sessions.rows).toEqual(Array.from({ length: sessionCount }, () => ({ external_auth_context: null })))
      }
      const expectedIdentity = refused ? initial : [expected]
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
